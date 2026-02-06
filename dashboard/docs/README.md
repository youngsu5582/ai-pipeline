# AI Pipeline Dashboard 문서

AI Pipeline Dashboard는 개인 지식 관리 시스템을 위한 크론 작업 관리 대시보드입니다. Node.js Express 서버와 Electron 데스크톱 앱으로 구성되어 있으며, Python 스크립트들을 스케줄링하고 모니터링합니다.

## 문서 목차

### 개요 문서

| 문서 | 설명 |
|------|------|
| [아키텍처](./architecture.md) | 시스템 구조, 컴포넌트 관계, 데이터 흐름 |
| [API 레퍼런스](./api-reference.md) | REST API 엔드포인트 명세 (30개+) |
| [작업 설정 가이드](./jobs-config.md) | jobs.json 구조 및 작업 정의 방법 |
| [Electron 앱](./electron-app.md) | 데스크톱 앱 기능 및 서비스 개요 |
| [배포 가이드](./deployment.md) | 설치, 실행, 배포 방법 |

### 코드 상세 분석 (Claude Code용)

| 문서 | 설명 |
|------|------|
| [Server 내부구조](./server-internals.md) | server.js의 모든 함수, 상태 변수, 실행 로직 상세 |
| [데이터 스키마](./data-schemas.md) | jobs.json, history.json, store 등 모든 데이터 구조 |
| [프론트엔드 가이드](./frontend-guide.md) | index.html의 JavaScript 함수, 이벤트, 렌더링 로직 |
| [Electron 서비스](./electron-services.md) | ClaudeCode, ObsidianWriter, SessionCollector 클래스 상세 |
| [흐름도](./flow-diagrams.md) | 작업 실행, 재시도, 체이닝, 인터랙티브 등 시나리오별 흐름 |
| [개발 가이드](./development-guide.md) | 새 기능 추가, 디버깅, 테스트 방법 |

## 빠른 시작

### 웹 대시보드 (Express 서버)

```bash
cd dashboard
npm install
npm run web:dev   # 개발 모드 (--watch)
npm run web       # 프로덕션
```

접속: http://localhost:3030

### 데스크톱 앱 (Electron)

```bash
npm run dev       # 개발 모드
npm start         # 프로덕션
```

## 주요 기능

### 1. 작업 스케줄링
- **크론 기반**: node-cron을 사용한 유연한 스케줄링
- **실행 제어**: 타임아웃, 재시도, 백오프 전략 지원
- **파이프라인 체이닝**: 작업 완료 후 다음 작업 자동 트리거

### 2. 대시보드 UI
- **카드/그래프 뷰**: 작업 목록을 카드 또는 의존성 그래프로 시각화
- **실시간 로그**: 작업 실행 중 stdout/stderr 실시간 확인
- **이력 관리**: 실행 이력 검색, 필터링, 페이지네이션

### 3. 인터랙티브 작업 (Electron 전용)
- **팝업 입력**: 스케줄에 따라 팝업으로 사용자 입력 수집
- **Claude 연동**: 입력 내용을 Claude로 가공하여 저장
- **Obsidian 연동**: Daily Note에 자동 기록

### 4. 알림 및 모니터링
- **Slack 알림**: 작업 성공/실패 시 Slack 웹훅 전송
- **통계 대시보드**: 성공률, 실행 횟수, 일별 트렌드
- **Auto-fix**: 패키지 누락 등 일반적 오류 자동 복구

## 기술 스택

| 영역 | 기술 |
|------|------|
| 서버 | Node.js, Express |
| 스케줄링 | node-cron |
| 데스크톱 앱 | Electron |
| 프론트엔드 | HTML/CSS/JS, Tailwind CSS |
| 그래프 시각화 | vis-network |
| 차트 | Chart.js |
| 설정 저장 | electron-store |
| AI 연동 | Claude Code CLI |

## 디렉토리 구조

```
dashboard/
├── server.js           # Express 서버 (메인)
├── jobs.json           # 작업 정의
├── package.json        # 의존성
├── public/             # 웹 UI
│   ├── index.html      # 대시보드
│   ├── quick-input.html
│   └── popup/          # 팝업 UI
├── electron/           # Electron 앱
│   ├── main.js         # Electron 메인
│   ├── preload.js      # 프리로드
│   ├── tray.js         # 시스템 트레이
│   ├── windows/        # 윈도우 컴포넌트
│   └── services/       # 서비스 레이어
├── logs/               # 실행 로그
│   └── history.json    # 실행 이력
└── docs/               # 문서
```

## 관련 프로젝트

- **scripts/**: Python 자동화 스크립트 (sync_github.py, daily.py 등)
- **config/**: 전역 설정 파일 (settings.yaml)
- **Obsidian Vault**: 데이터가 저장되는 지식 베이스
