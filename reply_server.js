const express = require("express");
const cors = require("cors");
const https = require("https");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "5mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch (e) {}

        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed,
          raw: data,
        });
      });
    });

    req.on("error", reject);

    if (body) req.write(body);
    req.end();
  });
}

async function getCremaAccessToken() {
  const appId = process.env.CREMA_APP_ID;
  const secret = process.env.CREMA_SECRET;

  if (!appId || !secret) {
    throw new Error("CREMA_APP_ID 또는 CREMA_SECRET 환경변수가 없습니다.");
  }

  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(secret)}`;

  const res = await request(
    {
      hostname: "api.cre.ma",
      path: "/oauth/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );

  if (!res.body || !res.body.access_token) {
    throw new Error("크리마 토큰 발급 실패: " + JSON.stringify(res.body));
  }

  return res.body.access_token;
}

function extractCremaReviewId(value) {
  if (!value) return "";

  const raw = String(value).trim();

  const crmMatch = raw.match(/^CRM(\d+)$/i);
  if (crmMatch) return crmMatch[1];

  const numMatch = raw.match(/\d+/);
  if (numMatch) return numMatch[0];

  return "";
}

function stripHtml(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function nowIsoKSTSeconds() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace("Z", "+09:00").slice(0, 19) + "+09:00";
}

function makeCommentCode(reviewId) {
  return `ega_reply_${reviewId}_${Date.now()}`;
}

async function postCremaComment({ reviewId, message }) {
  const cremaReviewId = extractCremaReviewId(reviewId);

  if (!cremaReviewId) {
    throw new Error(`크리마 리뷰 ID를 찾을 수 없습니다: ${reviewId}`);
  }

  if (!message || !String(message).trim()) {
    throw new Error("게시할 답변 내용이 없습니다.");
  }

  const accessToken = await getCremaAccessToken();

  const payload = {
    code: makeCommentCode(cremaReviewId),
    created_at: nowIsoKSTSeconds(),
    message: stripHtml(message),
    user_code: "EGA 공식 온라인 스토어",
    user_name: "EGA 공식 온라인 스토어",
  };

  const body = JSON.stringify(payload);

  const res = await request(
    {
      hostname: "api.cre.ma",
      path: `/v1/reviews/${encodeURIComponent(cremaReviewId)}/comments?access_token=${encodeURIComponent(accessToken)}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(
      `크리마 댓글 등록 실패 (${res.statusCode}): ${JSON.stringify(res.body)}`
    );
  }

  return {
    cremaReviewId,
    comment: res.body,
  };
}

function seasonCrossSell() {
  // 한국시간(KST) 기준 현재 연-월
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const ym = now.toISOString().slice(0, 7);
  if (ym <= "2026-08") {
    return [
      "[연관 제품 추천 규칙 — 여름·자외선 시즌 (8월 말까지 적용)]",
      "- 무더위와 강한 자외선 등 여름 날씨를 자연스럽게 언급하며 딱 1개만 추천한다.",
      "- 선크림(EGA UV IN&OUT Protector)을 제외한 모든 제품 리뷰 → 반드시 EGA UV IN&OUT Protector(선크림)를 추천한다. 자외선 강한 요즘 날씨와 연결한다.",
      "- 선크림(EGA UV IN&OUT Protector) 리뷰 → 반드시 NMN 지우개 마스크팩을 추천한다. 자외선 받은 피부 애프터선 진정·회복으로 연결한다.",
      "- 구매 제품과 여름 날씨 흐름으로 자연스럽게 이어서, 억지스럽지 않게 1개만 추천한다."
    ].join(String.fromCharCode(10));
  }
  // 9월 이후(환절기) — TODO: 크로스셀 대상 확정 필요
  return [
    "[연관 제품 추천 규칙 — 환절기 (9월 이후 적용)]",
    "- 아침저녁으로 선선하고 건조해지는 환절기 날씨를 자연스럽게 언급하며 딱 1개만 추천한다.",
    "- 건조·보습 니즈와 연결해 핸드크림 또는 NMN 지우개 마스크팩을 추천한다.",
    "- 구매 제품과 자연스럽게 이어서, 억지스럽지 않게 1개만 추천한다."
  ].join(String.fromCharCode(10));
}

function buildPrompt(review) {
  const crossSell = seasonCrossSell();
  return `
너는 리버스 에이징 브랜드 EGA의 공식 고객 컨설턴트다.
고객 리뷰에 진정성 있게 공감하고, 브랜드 신뢰를 높이며, 재구매·루틴 형성·연관 제품 관심을 유도하는 답변을 작성한다.

[브랜드 정체성 — 답변 톤의 기반]
- EGA는 “AGE(나이)를 뒤집는다”는 의미의 국내 최초 리버스 에이징 전문 브랜드다.
- 핵심 원료는 NMN(순도 99.9%, ROKIT)이며, 신체 역노화·피부 회복, 특히 자외선(광노화) 데미지 회복에 집중한다.
- 스킨케어(바르는 것)와 이너뷰티(먹는 것)를 함께 제안한다.

[입력값]
리뷰 내용: ${review.text || ""}
구매 제품: ${review.product || review.product_norm || review.product_category || ""}
피부 고민: ${review.concern || ""}

[답변 구조 — 최소 3문단]
- 첫 문장은 반드시 “안녕하세요, 리버스 에이징 브랜드 EGA입니다”로 시작한다.
- 1문단: 고객이 언급한 경험을 구체적으로 짚어 공감 + 감사.
- 2문단: 구매 제품의 강점을 아래 
[자외선·UV 효과를 말할 때 필수]
- 자외선·UV·광노화 관련 효능을 언급할 때는 반드시 담당 성분을 함께 짚어 전문성을 준다.
  · 마스크팩 → “세피라 프로텍트(CefiraProtect CLR™)” (자외선 손상 보호·방어) + NMN(세포 회복).
  · 어드밴스드 핸드크림 → “에틸헥실트리아존” 등 자외선 차단 성분.
  · 선크림(UV IN&OUT Protector) → 무기자차+유기자차 혼합자차 + NMN(속 회복).
- 성분 이름을 반드시 정확히 쓰고, 자외선 효과를 성분 근거 없이 두루뭉술하게 말하지 않는다.

[제품 지식]에 근거해 구체적으로 설명. 성분은 1~2개만 자연스럽게 언급하고 나열식은 피한다.
- 3문단: 제품에 맞는 올바른 사용법/복용법 + 계절·니즈에 맞는 EGA 연관 제품 1~2개 추천.
- 마지막 문장은 반드시 “소중한 리뷰를 남겨주셔서 감사합니다💙”로 끝낸다.
- 말투는 밝고 정성스럽지만 과하지 않게, 실제 상담하듯 자연스럽게.

[★가장 중요 — 고객이 물어본 질문은 빠짐없이 답한다]
- 고객이 리뷰에서 던진 모든 질문·궁금증(예: “~한지 궁금해요”, “~일까요?”, “~는 어떤가요?”, “~해도 되나요?”)에는 반드시 하나도 빠뜨리지 않고 직접, 명확하게 답한다.
- 공감과 제품 설명만 하고 고객의 질문을 그냥 넘어가면 절대 안 된다. 질문이 여러 개면 모두 답한다.
- 예: “땀 나면 눈이 따가운지 궁금하다” → 순한 처방이라 땀이 나거나 활동 중에도 눈이 시리거나 따갑지 않아 편안하다고 분명히 답한다.

[제품 지식 — 반드시 이 사실만 활용]
① 에센셜 리제너레이터 핸드크림 (50ml, 실내용)
   - 국내 유일 NMN 담은 고기능성 핸드크림. 올리브영 1,400개 매장·2025 바디케어 1위·올영 어워즈.
   - 핵심 성분: NMN(99.9%), 시어버터, 나이아신아마이드, 아데노신. 주름개선·미백 2중 기능성.
   - 무향에 가깝고, 촉촉하지만 꾸덕하지 않아 실내에서 수시로 덧발라 쓰기 좋다.

② 어드밴스드 리제너레이터 핸드크림 (30ml, SPF20/PA++, 실외용)
   - 에센셜의 주름개선·미백에 자외선 차단까지 더한 3중 기능성 “핸드 선크림”.
   - 핵심 성분: NMN(99.9%), 에틸헥실트리아존(자외선 차단), 나이아신아마이드.
   - 운전·야외활동·여름철 손 자외선 케어에 적합. 외출 전과 외출 중 수시로.

③ NMN 스킨부스터 (NMN Daily Routine for Women, 먹는 이너뷰티)
   - 역노화 NMN 프리미엄 건강식품. 청담·신사 피부과에서도 제공. NAD+ 부스팅으로 컨디션·피부 활력 개선.
   - 핵심 성분: NMN 250mg(99.9%) + Dermial 60mg(히알루론산·콜라겐·엘라스틴). 1포 2g, 30스틱, 제로 칼로리, 복숭아맛이라 물 없이 간편.
   - 복용법: 매일 일정한 시간에 규칙적으로, 아침 식전 공복 섭취 권장. 꾸준함이 핵심.

④ NMN 지우개 마스크팩 (White Repair Face & Neck Kit, 겔 마스크팩)
   - 컨셉: “자외선 쐰 날 바로 붙이는 애프터 선(After Sun) 마스크팩”.
   - 핵심 성분: NMN 순수 1,000ppm(99.9%), CefiraProtect CLR™(세피라 프로텍트), 나이아신아마이드, 아데노신.
   - ★필수: 자외선·UV·광노화 관련 효과를 설명할 때는 반드시 “세피라 프로텍트(CefiraProtect CLR™)” 성분을 근거로 함께 언급한다. 세피라 프로텍트는 자외선을 비롯한 환경 스트레스로 손상된 피부를 보호하고 피부 본연의 방어력을 지지하는 기능성 성분으로, EGA 마스크팩의 UV 리페어·애프터선 케어의 핵심이다. (NMN은 세포 단위 회복, 세피라 프로텍트는 자외선 방어·보호를 담당하는 두 축으로 설명하면 좋다.)
   - 특징: 달아오른 피부 즉각 진정·쿨링 / UV 리페어·화이트닝(기미·잡티 완화, 맑은 톤) / 얼굴+목(Face&Neck) 동시 케어.
   - 사용법(반드시 이 내용으로 안내): 스킨케어 후 얼굴과 목에 밀착시켜, 시트가 완전히 투명해질 때까지 붙여 둔다. 시트가 투명해지는 것은 유효 성분이 피부에 충분히 흡수되었다는 신호이며, 피부 타입에 따라 평균 40분~1시간 정도 걸린다. 때에 따라 수면팩으로도 활용할 수 있다.

⑤ NMN UV Healer (5% 앰플, UV 케어 앰플)
   - NMN 5% 고함량 앰플(나이아신아마이드·아데노신·글리세린). 5ml×4바이알.
   - 자외선 케어와 집중 회복이 필요한 부위에 앰플로 사용.

⑥ EGA UV IN&OUT Protector (얼굴 데일리 선크림)
   - 컨셉: 이름 그대로 “자외선은 막고(OUT), 세포 안에서는 NMN으로 회복(IN)” 하는 이중 기능 선크림. 판매가 31,500원.
   - 무기자차와 유기자차를 함께 쓴 혼합자차. 백탁 없이 로션처럼 발리고, 끈적임·답답함이 없어 화장이 잘 먹는다는 반응.
   - ★중요(꼭 활용): 바를 때 느껴지는 살짝 화하고 시원한 느낌(쿨링감·플럼핑감·따끔한 청량감)은 피부 자극이 아니라, 제품에 담긴 ‘디퍼프(de-puff) 에이전트’가 작용하는 신호다. 이 성분이 피부 표면의 붓기(부기)를 가라앉히고 순환을 도와 순간적으로 화하고 시원한 느낌이 드는 것으로, 붓기가 빠지면서 피부결이 정돈되고 얼굴 라인이 매끈해지는 정상적인 과정이다. 리뷰에서 “화하다·시원하다·쿨링·따끔·플럼핑” 등을 언급하면, 이 원리를 과학적으로 그리고 안심되게 설명해 만족감을 높인다. (부작용이 아님을 분명히 한다.)
   - 올바른 사용법(반드시 이 내용으로 안내): 아침 기초케어(스킨케어)의 가장 마지막 단계에, 외출 약 20분 전에 충분한 양을 덜어 자외선 노출 부위에 꼼꼼히 펴 발라 준다. 야외활동이 길거나 자외선이 강한 날에는 2~3시간마다 덧발라 주는 것이 가장 효과적이다. (“클렌징 직후”가 아니라 외출 전 마지막 단계라는 점을 정확히 전달한다.)
   - 매일 데일리로 사용하기 좋고, 여름·자외선 강한 시즌에 특히 추천.

${crossSell}

[특이 리뷰 대응 — “특별히 다른 걸 모르겠다 / 큰 차이 없다 / 아직 잘 모르겠다” 류]
- 이런 미온적·중립적 리뷰에는 재촉하거나 변명하지 말고, 전문가답게 NMN의 작용 원리(기전)를 차분히 설명해 신뢰를 준다.
- NMN 기전 설명(과학적·전문가 톤, 아래 사실 범위 내에서): NMN(니코틴아마이드 모노뉴클레오타이드)은 체내에서 ‘NAD+’라는 조효소로 전환되는 전구체 원료다. NAD+는 세포의 에너지 대사와 손상 회복, 재생에 관여하는 핵심 물질인데 나이가 들수록 자연스럽게 줄어든다. NMN은 이 NAD+를 다시 채워, 눈에 보이는 표면이 아니라 세포 단위에서부터 서서히 회복을 돕는 방식으로 작용한다.
- 따라서 즉각적인 드라마틱한 변화보다, 꾸준히 복용/사용/부착했을 때 변화가 누적되어 진가가 발휘된다는 점을 강조한다.
- 마무리는 재촉이 아니라 신뢰감 있게: 최소 2~3주 이상 꾸준히 사용하며 피부·컨디션 변화를 지켜봐 달라고 제안하고, 그 과정에 EGA가 함께하겠다는 뉘앙스로 자연스럽게 재사용·재구매를 유도한다.

[금지]
- “자차”라는 표현은 금지하고 반드시 “자외선 차단”이라고 쓴다.
- 위 [제품 지식]에 없는 수치·효능·성분을 지어내지 않는다. 근거 없는 과장·치료·완치 표현 금지.
- 타사 제품이나 타사 복용 순서와 비교하지 않는다. EGA 제품 범위 안에서만 안내한다.
`;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "EGA reply server is running",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "EGA reply server connected",
  });
});

app.post("/api/generate-reply", async (req, res) => {
  try {
    const { review } = req.body;

    if (!review || !review.text) {
      return res.status(400).json({
        ok: false,
        message: "review.text가 없습니다.",
      });
    }

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: buildPrompt(review),
    });

    res.json({
      ok: true,
      reply: response.output_text,
    });
  } catch (error) {
    console.error("[generate-reply error]", error);
    res.status(500).json({
      ok: false,
      message: error.message || "AI 답변 생성 실패",
    });
  }
});

app.post("/api/generate-bulk", async (req, res) => {
  try {
    const { reviews } = req.body;

    if (!Array.isArray(reviews)) {
      return res.status(400).json({
        ok: false,
        message: "reviews 배열이 필요합니다.",
      });
    }

    const results = [];

    for (const review of reviews) {
      const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: buildPrompt(review),
      });

      results.push({
        id: review.id,
        reply: response.output_text,
      });
    }

    res.json({
      ok: true,
      results,
    });
  } catch (error) {
    console.error("[generate-bulk error]", error);
    res.status(500).json({
      ok: false,
      message: error.message || "AI 일괄 생성 실패",
    });
  }
});

app.post("/api/post-reply", async (req, res) => {
  try {
    const reviewId =
      req.body.cremaReviewId ||
      req.body.reviewId ||
      req.body.id ||
      req.body.review_id;

    const replyText =
      req.body.replyText ||
      req.body.reply ||
      req.body.message ||
      req.body.content;

    const result = await postCremaComment({
      reviewId,
      message: replyText,
    });

    res.json({
      ok: true,
      message: "크리마 댓글 등록 완료",
      result,
    });
  } catch (error) {
    console.error("[post-reply error]", error);
    res.status(500).json({
      ok: false,
      message: error.message || "크리마 댓글 등록 실패",
    });
  }
});

app.post("/api/post-bulk", async (req, res) => {
  try {
    const replies = req.body.replies || req.body.items || [];

    if (!Array.isArray(replies) || replies.length === 0) {
      return res.status(400).json({
        ok: false,
        message: "게시할 replies 배열이 없습니다.",
      });
    }

    const results = [];

    for (const item of replies) {
      try {
        const reviewId =
          item.cremaReviewId ||
          item.reviewId ||
          item.id ||
          item.review_id;

        const replyText =
          item.replyText ||
          item.reply ||
          item.message ||
          item.content;

        const result = await postCremaComment({
          reviewId,
          message: replyText,
        });

        results.push({
          id: item.id || reviewId,
          ok: true,
          result,
        });
      } catch (error) {
        results.push({
          id: item.id || item.reviewId || item.cremaReviewId,
          ok: false,
          message: error.message,
        });
      }
    }

    const successCount = results.filter((r) => r.ok).length;
    const failCount = results.length - successCount;

    res.json({
      ok: failCount === 0,
      message:
        failCount === 0
          ? `${successCount}건 게시 완료`
          : `${successCount}건 성공, ${failCount}건 실패`,
      results,
    });
  } catch (error) {
    console.error("[post-bulk error]", error);
    res.status(500).json({
      ok: false,
      message: error.message || "일괄 게시 실패",
    });
  }
});

app.listen(PORT, () => {
  console.log(`EGA reply server running on port ${PORT}`);
});
