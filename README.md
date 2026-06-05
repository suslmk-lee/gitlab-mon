# gitlab-mon

셀프호스팅 GitLab + Jira Cloud 통합 모니터링 데스크톱 앱 (Wails v2 + Go + React-TS).

GitLab 인스턴스 전체의 push / MR / merge / 파이프라인 활동과 Jira 이슈 현황을
글래스모피즘 UI의 단일 앱에서 모니터링하고, Jira는 칸반보드로 직접 업데이트까지 할 수 있습니다.

## 화면 구성

### 활동 피드
- 90일 윈도우의 전체 인스턴스 이벤트: push ⬆ / merge ⛙ / MR ⎇ / 댓글 💬
- 종류별 필터 + 사용자/레포/브랜치 검색, 기간 토글(7/30/90일)
- 사이드 패널: 열린 MR 목록, 최근 활동 레포 (클릭 → 브라우저)

### 통계
- 지표 카드: MR 생성/머지, 평균 머지 리드타임, 평균 첫 리뷰 시간, 리뷰 없는 머지 비율 등
- **사용자별 활동 지수** 리더보드 — 가중치(커밋/MR/머지/댓글) ⚙ 버튼으로 조정 가능, 토큰봇 분리 토글
- **사용자 × 날짜 히트맵** (GitHub 잔디 스타일)
- 날짜별 액션 스택 차트, 시간대별 분포, 레포별 활동 Top 10
- **코드 변경량 Top 10** — 기본 브랜치 커밋의 +추가/-삭제 라인 (git author → GitLab 계정 매핑)
- **리뷰어 활동 Top 10** — 승인 수 + MR 댓글
- 유휴 레포 목록 (기간 내 무활동)
- **CSV 내보내기** — 현재 기간·가중치 기준 사용자 요약 → ~/Downloads
- 리더보드/히트맵/레포 이름 클릭 → 피드 드릴다운

### 파이프라인
- 30/90일 파이프라인 수, 성공률, 실패, 실행 중, 평균 소요(근사)
- 실행/대기 중 목록(펄스 표시), 날짜별 결과 스택, 프로젝트별 성공률(70% 미만 빨강), 최근 실패

### Jira
- 열린/진행 중/생성/완료/기한 초과 카드, 담당자별·프로젝트별 열린 이슈, 최근 업데이트
- **칸반보드**: 프로젝트 선택 → 상태별 컬럼(4컬럼 폭 기준)
  - 하위 이슈는 부모 카드 안에 한 줄(상태 칩·키·제목)로 통일 표시, 펼치기/접기 + "하위 m/n" 진행 뱃지
  - **카드 드래그 → 실제 Jira 상태 전환** (transitions API)
  - 카드/하위 이슈 클릭 → **상세 팝업**: 서식 있는 설명(ADF→HTML 변환: 제목·표·목록·코드·체크리스트),
    상태 변경 버튼, 하위 이슈 탐색, 상위 이슈 링크, Jira에서 열기

### 기타
- **macOS 알림**: 파이프라인 실패, 새 MR (osascript, 시작 시 기준선 잡아 스팸 방지, 4건 초과 시 요약)
- **백그라운드 상주**: 창을 닫아도 수집·알림 지속 (Dock 클릭으로 재표시, ⌘Q로 종료)
- 글래스모피즘 UI: macOS 반투명 창(vibrancy) + backdrop blur

## 아키텍처

```
app.go            폴링 루프(30초) + 스냅샷 조립/발행, 부분 실패 경고
internal/gitlab/  GitLab REST v4 클라이언트
internal/jira/    Jira Cloud REST v3 클라이언트 (+ ADF→HTML 변환기)
internal/config/  설정 로딩 + macOS Keychain 토큰 저장
commits.go        코드 변경량 수집 (with_stats 커밋 목록)
mr_reviews.go     MR notes/approvals → 첫 리뷰·승인자
jira_collect.go   Jira 이슈 동기화 + 칸반 이동/상세 바운드 메서드
notify.go         macOS 알림 디프
meta_cache.go     시작 즉시 표시용 메타 캐시
frontend/         React-TS 대시보드 (단일 App.tsx)
cmd/check, cmd/authors, cmd/adfcheck   헤드리스 점검 도구
```

### 수집 전략 (저부하 설계)

모든 수집은 **증분**이며 디스크 캐시(`~/Library/Application Support/gitlab-mon/`)로 영속화됩니다.
앱 시작 시 캐시로 즉시 화면을 그리고(1초 미만) 백그라운드에서 갱신합니다.

| 대상 | 주기 | 트리거/방식 |
|---|---|---|
| 프로젝트·열린/머지 MR | 30초 | 전체 목록 (2~4 요청) |
| 이벤트 | 30초 | `last_activity_at` 변경 프로젝트만, 캐시 도달 시 페이지 중단 |
| 파이프라인 | 30초/5분 | 실행 중·활동 변경 프로젝트만 매 사이클, 전체 스윕은 5분 |
| MR 리뷰(notes/approvals) | 30초 | `updated_at` 변경 MR만 |
| 커밋 라인 통계 | 30초 | 활동 변경 프로젝트의 최신 커밋 이후만 (SHA dedupe) |
| 버전·통계·그룹·사용자 | 5분 | slow 사이클 |
| Jira 이슈 | 5분 | 마지막 수집 이후 `updated`만 병합 |

- 평시 사이클당 GitLab 요청 ~5개, Jira 요청 0~1개
- 스냅샷 시그니처가 같으면 프론트 재전송·디스크 쓰기 생략(가벼운 tick만)
- 수집 상한/실패는 경고 배너로 노출 (조용한 누락 없음)

## 설정

우선순위: 환경변수 → `env.local`(실행파일 옆 또는 cwd) → **macOS Keychain** → `config.json`

```sh
# env.local 예시 (토큰은 첫 실행 시 Keychain으로 자동 이전됨)
GITLAB_TOKEN=glpat-...        # admin 계정, read_api scope
JIRA_URL=https://<site>.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_TOKEN=ATATT...           # id.atlassian.com → API tokens
```

- GitLab 토큰: Keychain `gitlab-mon` / `<host>`
- Jira 토큰: Keychain `gitlab-mon` / `jira:<host>`
- `config.json`에는 URL/이메일만 저장 (평문 토큰 없음)
- 설정이 없으면 첫 실행 시 앱 내 설정 화면 표시

## 개발 / 빌드

```sh
wails dev      # 핫리로드 개발 모드
wails build    # 단일 실행파일 → build/bin/gitlab-mon.app
go run ./cmd/check    # API 데이터 경로 헤드리스 점검
```

산출물은 프론트엔드가 임베드된 단일 바이너리로, 복사해서 어디서든 실행 가능합니다.
요구사항: Go 1.23+, Wails v2.12+, Node 18+ (빌드 시).
