# EGA 리뷰 자동화 시스템 — 개발 인수인계 (HANDOFF)

> **이 문서 하나로 새 Claude(또는 새 개발자)가 이 프로젝트를 이어받아 바로 개발할 수 있게 정리한 문서.**
> 새 Claude 세션을 시작하면 **가장 먼저 이 파일을 읽어달라고 하세요.**
> 최종 갱신: 2026-08-06 (BUILD 250806-E 기준) · 인계자: 은진 → 후임: 지현

---

## 0. 30초 요약

- **무엇**: 매일 아침 크리마·카페24 리뷰/문의/주문을 자동 수집 → 웹 대시보드에서 확인 → **AI가 답변을 생성해 크리마에 게시**하는 시스템. + 판매·재구매·리뷰작성률 분석 리포트.
- **사용자가 보는 대시보드**: `https://egalabs.co.kr/softdubu/ReviewArchive/` (로그인: `softdubu@ega.co.kr` = 마스터)
- **AI 답변 서버**: `https://ega-review-insight-archive.onrender.com` (onrender, OpenAI 사용)
- **코드 저장소(2개)**: `egalabs/ReviewArchive`(비공개, 대시보드 라이브 소스) · `softdubu-spec/EGA_Review_Insight_Archive`(공개, onrender 소스 + 미러)
- **배포**: `gh api`로 GitHub repo에 파일 PUT → 서버가 자동으로 받아감.

---

## 1. ⚠️⚠️ 배포 대상 (이거 헷갈리면 "안 바뀐다"의 지옥 — 이번 세션 최대 삽질)

| 무엇을 바꾸나 | 배포할 repo | 반영 경로 | 확인법 |
|---|---|---|---|
| **대시보드 `index.html`** | **`egalabs/ReviewArchive`** (+ softdubu 미러) | egalabs.co.kr 서버가 ~20~60초 내 자동 pull | 사이드바 하단 `BUILD YYMMDD-X` 초록 도장 |
| **`reply_server.js` (AI 프롬프트/서버)** | **`softdubu-spec/EGA_Review_Insight_Archive`** | onrender가 push 감지 → 자동 재배포(2~5분) | `GET /api/prompt-config`, `/health` |
| **`prompt_config.json` (제품별 프롬프트)** | **`softdubu-spec`** (+ egalabs 미러) | onrender 재배포 시 로드 | `GET /api/prompt-config` |
| **데이터 JSON / 스크립트 / 워크플로** | **`egalabs/ReviewArchive`** (데일리 워크플로가 여기서 돎) | 다음 실행 or 즉시 | Actions 로그 |

**핵심**: 대시보드는 `egalabs/ReviewArchive`, AI 서버는 `softdubu-spec`. `softdubu-spec.github.io`(GitHub Pages)는 **무인증 공개 미러**라 브라우저 자동 테스트할 때 편하지만, **사용자가 실제로 보는 건 egalabs.co.kr** 이므로 index.html은 반드시 egalabs에도 올릴 것.

### 배포 명령 패턴 (gh CLI, `softdubu-spec` 계정으로 인증됨)
```bash
export PATH="$PATH:/c/Program Files/GitHub CLI:/c/Users/user/AppData/Local/GitHubCLI"
REPO=egalabs/ReviewArchive        # 또는 softdubu-spec/EGA_Review_Insight_Archive
SHA=$(gh api repos/$REPO/contents/index.html --jq '.sha')
base64 -w0 "로컬파일" > b64.txt   # {message, content:<b64>, sha:<SHA>, branch:"main"} JSON 구성
gh api --method PUT repos/$REPO/contents/index.html --input payload.json --jq '.commit.sha'
# 확인: curl "https://egalabs.co.kr/softdubu/ReviewArchive/index.html?t=$(date +%s)" | grep BUILD
```
- 1MB↑ 파일(reviews.json 등)은 contents API가 빈값 → 읽을 땐 `-H "Accept: application/vnd.github.raw"`.
- **배포마다 index.html의 `BUILD` 도장을 bump**(사이드바 `#build-stamp`). 반영 확인용.

---

## 2. 시스템 구성 (아키텍처)

```
[매일 09:00 KST] GitHub Actions (egalabs/ReviewArchive · crema_sync.yml)
   ├─ fetch_crema.js          크리마 리뷰 (채널 자동분류: 카페24/스마트스토어/올리브영)
   ├─ fetch_oliveyoung.js     올영 스크래퍼 (⚠️ 현재 403 차단 실패 — 8번 참고)
   ├─ fetch_cafe24_orders.js  카페24 주문/상품 (토큰 .cafe24_token.json, 사용시 회전)
   ├─ fetch_cafe24_inquiries.js  카페24 Q&A + 1:1 문의
   ├─ fetch_board_replies.js (7c)  ega.co.kr 게시판(board_no=4) 답변현황 → board_reply_status.json
   └─ build_*.js              판매·재구매·작성률·워크플로 분석 JSON
        ↓ (repo 커밋)
[egalabs/ReviewArchive] ──자동 pull──> [egalabs.co.kr Express] ──> 대시보드(로그인 후)
[softdubu-spec]         ──자동 배포──> [onrender reply_server] ──> AI 답변 생성·게시
                                              ↕ OpenAI / 크리마 API
```

### 서버 2개
- **egalabs.co.kr**: nginx + **커스텀 Express**. `/softdubu/ReviewArchive/`에서 대시보드 서빙. **서버측 로그인**(`api/auth/login`, 마스터=softdubu@ega.co.kr). `egalabs/ReviewArchive` repo 자동 pull. 데이터 파일은 세션 필요(무인증 401). ⚠️ `/api/*`·`/api/v1/repos/...`는 splash 반환(가짜 Gitea 함정).
- **onrender** (`ega-review-insight-archive.onrender.com`): `reply_server.js`(Express, **무인증**). `softdubu-spec`에서 자동배포. **무료플랜 → 15분 유휴 후 콜드스타트(첫 요청 20~50초)**. 엔드포인트: `/health`, `/api/generate-reply`, `/api/generate-bulk`, `/api/post-reply`, `/api/post-bulk`, `/api/prompt-config`(GET/POST). env: `OPENAI_API_KEY`, `CREMA_APP_ID/SECRET`, (`GH_TOKEN` — 아직 미설정).

### ⚠️ reply_server.js가 두 repo에서 다름
- `egalabs/ReviewArchive/reply_server.js` (~33KB, **auth 있음**) — **onrender 안 씀(휴면)**.
- `softdubu-spec/.../reply_server.js` (~21KB, **auth 없음**) — **onrender가 실제 구동하는 것. 프롬프트 수정은 여기!**
- 판별법: `curl .../api/auth/me` → 404면 softdubu 버전(=라이브). 두 파일 **프롬프트 텍스트는 동일하게** 유지.

---

## 3. 로컬 폴더 구조

`C:\Users\user\Desktop\00_프로젝트\EGA_GitHub_업로드\`
- `1_루트에 올릴 파일/index.html` → repo 루트 `index.html` (대시보드, ~470KB 단일 HTML)
- `1_루트에 올릴 파일/reviews.json` → repo 루트 `reviews.json`
- `2_scripts에 올릴 파일/*.js` → repo `scripts/*.js`
- `4_workflows에 올릴 파일/*.yml` → repo `.github/workflows/*.yml` (⚠️ 로컬 `sync-reviews.yml` = repo `crema_sync.yml` 이름 다름)
- `CLAUDE.md` — 기존 프로젝트 노트 · `HANDOFF.md` — **이 문서**

> **진실은 항상 repo.** 로컬 사본은 오래됐을 수 있으니 편집 전 `gh api ... raw`로 최신본을 받아 작업 권장.

---

## 4. 주요 파일 / 데이터

| 파일 | 무엇 | 생성/갱신 |
|---|---|---|
| `index.html` | 대시보드 전체 (단일 HTML, 인라인 JS) | 수동 배포 |
| `reviews.json` | 전체 리뷰(크리마+올영) ~4,594건 | 데일리 fetch_crema |
| `prompt_config.json` | **제품별 편집 가능 프롬프트** (essential/advanced/inoutSet/routineSet/skinbooster/maskpack/ampoule/suncream) | 웹 "프롬프트 관리" or 수동 |
| `crema_answered.json` | `{answeredIds, unansweredIds}` 크리마 리뷰ID별 답변여부(정확) — 대시보드 **미답변 판정** | `dedup_comments.yml` scan 실행 시 |
| `board_reply_status.json` | 게시판 답변 키(날짜+본문) — 미답변 판정 폴백 | 데일리 fetch_board_replies |
| `inquiries_cafe24.json` | 카페24 Q&A/문의 | 데일리 |
| `sales_*.json` · `repurchase_cafe24.json` · `crema_review_rate.json` · `review_workflow.json` | 분석 페이지 데이터 | 데일리 build_*.js |
| `.cafe24_token.json` | 카페24 OAuth 토큰(회전) — repo에 커밋됨(비공개) | 워크플로가 갱신 |

---

## 5. AI 답변 프롬프트 시스템 (핵심)

- `reply_server.js`의 `buildPrompt(review)`가 프롬프트 조립. **[제품 지식] 블록은 `prompt_config.json`의 products에서 읽음**(`activeProductKnowledge()`), 크로스셀은 `seasonCrossSell()`(코드).
- **웹에서 편집**: 사이드바 **🧠 프롬프트 관리** → 제품별 textarea 수정 → 저장(`POST /api/prompt-config`) → **서버 메모리 즉시 반영**.
  - ⚠️ **영구 저장은 onrender에 `GH_TOKEN`(softdubu-spec repo Contents 쓰기 권한) env 필요.** 없으면 저장이 메모리에만 있어 서버 재시작 시 초기화. onrender env에 GH_TOKEN 추가하면 `committed:true`로 영구화.
- **크로스셀(현재, 여름 ≤2026-08)**: 선크림 제외 대부분 → 선크림. 핸드크림: 에센셜↔어드밴스드 서로, 인앤아웃세트→선크림, **리버스 루틴 세트/키트→선크림**. 선크림→마스크팩. **9월(환절기) 브랜치는 TODO**.
- **금지/주의(사용자 피드백 누적)**: 신조어 금지("투인원"류), "국내 유일" 금지, "자차"→"자외선 차단", 구매 안 한 제품 성분 끌어오지 말 것(세피라 프로텍트는 마스크팩만), 자외선 언급시 담당 성분 근거, 고객 질문 빠짐없이 답변, 부정 리뷰는 개별화(NAD 개인차).
- **크리마 게시**: `postCremaComment` — OAuth → access_token → `POST /v1/reviews/{id}/comments`. `user_code`/`user_name`="EGA 공식 온라인 스토어"(둘 다여야 작성자 정상 표기). **게시 전 중복 체크**(이미 EGA 답변 있으면 skip) 내장.

---

## 6. 크리마 API 메모

- 인증: `POST api.cre.ma/oauth/token` (client_credentials) → access_token.
- 댓글: `GET/POST/DELETE /v1/reviews/{review_id}/comments[/{id}]?access_token=...`.
- ⚠️ **`/v1/reviews` 목록 API는 최근 ~63건만 노출.** 전체 답변현황은 reviews.json 크리마ID(`CRM####`→숫자)를 하나씩 GET 해야 함(`dedup_crema_comments.js`가 이 방식).
- 채널: 리뷰 message 끝 "…에서 작성된 구매평" 마커로 fetch_crema가 분류.

---

## 7. 이번 세션(2026-08-04~06) 작업 로그

1. **일괄 게시 버그 수정**(payload 키) + **배포 대상 혼선 발견/정리**(egalabs vs softdubu).
2. **답변 관리 UX**: 카드 전체 클릭 선택+하이라이트, KPI카드-필터 동기화, 결과/에러 **중앙 팝업**, 일괄 게시/생성 **진행률 바(X/N)**.
3. **미답변 판정 정확화**: 게시판 → **크리마 실측(crema_answered.json, ID 정확매칭)**. 미답변 4,099→**1,277**. 답변관리 뱃지=미답변 수.
4. **크리마 중복 답변 정리 94건 삭제** + **재발방지(게시 전 중복체크)** + 0건 검증 → `dedup_comments.yml`.
5. **프롬프트 수정**: 핸드크림("국내 유일" 삭제·SPF20·**인앤아웃세트=에센셜+어드밴스드 혼합**·임상수치), NAD 개별화, 마스크팩 사용법, **리버스 루틴 프로그램/세트(토탈케어)** + 세트→선크림 크로스셀.
6. **프롬프트 웹 편집기**(🧠 프롬프트 관리) + `prompt_config.json` + `/api/prompt-config`.
7. **UI 정리**: 답변/문의 아카이브 탭 삭제, 카페24 Q&A 뱃지=미답변 문의, 사이드바 뱃지 색 파란색 통일.
8. **올영 자동수집 조사**: 스크래퍼 403 차단 → **크리마 "외부채널 리뷰 연동"으로 올영 연동 신청** 권장(fetch_crema가 자동 분류하는 코드 이미 있음).

---

## 8. 열린 항목 / 다음 할 일

**개발/자동화**
- [ ] **onrender에 `GH_TOKEN` 추가** → 프롬프트 웹 저장 영구화.
- [ ] **크리마 올리브영 채널 연동 신청**(관리자 채팅 or review@cre.ma) → 올영 자동 유입.
- [ ] **9월 환절기 크로스셀 대상 확정**(seasonCrossSell 환절기 브랜치).
- [ ] **스마트스토어 답변현황**: 네이버 답변은 크리마/게시판이 못 잡음 → 미답변에 스스 과다집계(약 1,065). 네이버 데이터 소스 필요.
- [ ] `crema_answered.json` 데일리 자동화 여부 결정(크리마 API 4,000+회·~7분).

**분석/기획 (이전 세션 로드맵, 유효)**
- [ ] **회원 CSV 통합**(카페24 관리자>회원관리>엑셀): 회원 vs 실제 구매자·미구매·휴면 분리.
- [ ] **스마트스토어 주문 CSV** 재구매 분석(카페24와 동일 방식).
- [ ] **"루티너들의 리뷰" UI**: 상세페이지에 2회+ 구매 루티너 후기 영역.
- [ ] **누적 적립금 CRM 연결**(1~5회 차등).

**계정/소유권 인수인계** — 별도 체크리스트 있음(GitHub·onrender·egalabs.co.kr·크리마·카페24·슬랙·OpenAI). ⚠️ 개인 계정을 먼저 지우면 자동수집·서버 멈춤 → 후임 세팅 후 마지막에 정리.

---

## 9. 함정 / 컨벤션

- 대시보드 안 바뀌면 → **egalabs/ReviewArchive에 배포했나** + BUILD 도장 + `Ctrl+Shift+R`.
- 프롬프트 안 바뀌면 → **softdubu-spec에 배포했나** + onrender 재배포(2~5분) 기다렸나.
- 프롬프트 텍스트 추출/삽입 시 **CRLF/LF 주의**(템플릿 리터럴은 LF 정규화 → prompt_config는 LF).
- onrender 콜드스타트로 첫 요청 느림(UI가 감안함).
- 대용량 파일은 gh contents가 빈값 → raw 미디어타입.
- **진실은 repo**(로컬 사본 신뢰 금지).

---

## 10. 팀·사용자 톤 / 취향 (은진님 → 대표님 보고 스타일)

- **자기 가설 → 데이터 검증 → 실패 인정** 흐름 선호(대표님 스타일). "기획=효과적인 새 시작" 사례 좋아함.
- 보고 형식: **짧은 멘트 + 표 + 다음 액션 명확**. "내 생각 + 고객 보이스 + 데이터" 공식 자주 강조.
- 슬랙 메시지 다듬을 땐 기본 톤 유지 + 가독성만 정리. 새 시도에 적극적(빠르게 만들자 → OK).
- **핵심 KPI(분기)**: "재구매 리뷰 비중" 단일 집중. (숫자는 데이터 정제로 여러 번 수정됨 — 최신은 재계산 필요. 재구매자가 첫구매자보다 후기 약 2.4~2.5배 작성 = 가설 입증.)
- **EGA 콘텐츠 기본 톤 = 프리미엄**(별도 지시 없으면). CS 답변은 **자사 제품 범위로 한정**(타제품 복용순서 안내 X).

---

## 11. 새 Claude 세션에서 이어서 개발하는 법

1. 로컬 폴더(`C:\Users\user\Desktop\00_프로젝트\EGA_GitHub_업로드`)에서 시작하거나 repo clone.
2. 새 Claude에게: **"HANDOFF.md 먼저 읽어줘"**.
3. `gh auth status`로 repo 접근 계정 확인(2개 repo push 권한 필요 — 인수인계 시 후임 계정으로 재인증).
4. 작업 → **1번 배포표대로** 배포 → BUILD 도장/엔드포인트로 검증.
5. 큰 변경 전 `gh api ... raw`로 repo 최신본 받아 그 위에 작업.

— 끝. 막히면 이 문서의 해당 섹션부터 확인하면 대부분 답이 있음.
