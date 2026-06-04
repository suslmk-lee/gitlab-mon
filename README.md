# gitlab-mon

`ci.quantumcns.ai` GitLab 인스턴스 모니터링 데스크톱 앱 (Wails v2 + Go + React).

전체 인스턴스의 push / MR 생성 / merge / 댓글 활동을 30초 주기로 폴링해서
활동 피드, 열린 MR 목록, 최근 활동 레포를 한 화면에 보여줍니다.

## 구조

- `internal/gitlab/` — GitLab REST v4 클라이언트 (Events·Projects·MRs·Statistics, admin 토큰으로 `scope=all` 조회)
- `internal/config/` — 설정 로딩: env vars → `env.local` → `~/Library/Application Support/gitlab-mon/config.json`
- `app.go` — 폴링 루프 + 스냅샷 캐시, 프론트엔드에 `snapshot` 이벤트로 push.
  프로젝트별 이벤트는 증분 수집(이미 받은 이벤트에 도달하면 중단)하고
  `events-cache.json`에 영속화해 재시작 시 변경분만 재조회
- `frontend/` — React + TS 대시보드 (다크 테마)
- `cmd/check/` — UI 없이 API 데이터 경로를 점검하는 헤드리스 도구 (`go run ./cmd/check`)

## 설정

우선순위 순:

1. 환경변수 `GITLAB_URL`, `GITLAB_TOKEN`
2. 실행파일 옆 또는 현재 디렉토리의 `env.local` (`GITLAB_TOKEN=glpat-...`)
3. `~/Library/Application Support/gitlab-mon/config.json` (앱 첫 실행 설정 화면에서 저장됨)

토큰은 admin 계정의 Personal Access Token, scope `read_api`.

## 개발 / 빌드

```sh
wails dev      # 핫리로드 개발 모드
wails build    # 단일 실행파일 빌드 → build/bin/gitlab-mon.app
```

빌드 산출물 `build/bin/gitlab-mon.app`은 프론트엔드 에셋이 임베드된 단일 바이너리이며
그대로 복사해서 어디서든 실행 가능 (`Contents/MacOS/gitlab-mon` 단독 실행도 가능).
