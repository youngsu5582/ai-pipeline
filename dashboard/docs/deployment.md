# 배포 가이드

AI Pipeline Dashboard의 설치, 실행, 배포 방법을 설명합니다.

## 요구사항

### 시스템 요구사항

| 항목 | 요구사항 |
|------|---------|
| Node.js | v18 이상 |
| Python | 3.9 이상 (스크립트용) |
| OS | macOS, Linux, Windows |

### 선택적 요구사항

| 항목 | 용도 |
|------|------|
| Claude Code CLI | 인터랙티브 작업의 AI 처리 |
| Obsidian | Daily Note 저장 |
| Slack Webhook | 알림 전송 |

## 설치

### 1. 의존성 설치

```bash
cd dashboard
npm install
```

### 2. Python 환경 설정 (스크립트용)

```bash
cd ../  # ai-pipeline 루트
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 3. 설정 파일

#### config/settings.yaml

```bash
cp config/settings.example.yaml config/settings.local.yaml
```

```yaml
# config/settings.local.yaml
vault:
  path: ~/Documents/Obsidian/MyVault
  daily_folder: DAILY

github:
  repos:
    - /path/to/repo1
    - /path/to/repo2

slack:
  webhook_url: https://hooks.slack.com/services/...
```

#### jobs.json 설정

대시보드 UI 또는 직접 편집:

```json
{
  "settings": {
    "slackWebhookUrl": "https://hooks.slack.com/...",
    "slackEnabled": true,
    "dashboardUrl": "http://localhost:3030"
  }
}
```

## 실행

### 웹 대시보드 (Express 서버만)

```bash
# 개발 모드 (파일 변경 시 자동 재시작)
npm run web:dev

# 프로덕션
npm run web
```

접속: http://localhost:3030

### Electron 데스크톱 앱

```bash
# 개발 모드
npm run dev

# 프로덕션
npm start
```

## 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | 3030 | 서버 포트 |
| `DASHBOARD_URL` | http://localhost:3030 | 대시보드 URL (알림 링크) |
| `SLACK_WEBHOOK_URL` | - | Slack 웹훅 URL |
| `NODE_ENV` | production | development면 개발 모드 |

### .env 파일 사용

```bash
# .env
PORT=3030
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
```

## 백그라운드 실행

### macOS - launchd

```bash
# ~/Library/LaunchAgents/com.user.ai-pipeline-dashboard.plist
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.ai-pipeline-dashboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/user/ai-pipeline/dashboard/server.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/ai-pipeline-dashboard.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/ai-pipeline-dashboard.error.log</string>
    <key>WorkingDirectory</key>
    <string>/Users/user/ai-pipeline/dashboard</string>
</dict>
</plist>
```

```bash
# 등록
launchctl load ~/Library/LaunchAgents/com.user.ai-pipeline-dashboard.plist

# 해제
launchctl unload ~/Library/LaunchAgents/com.user.ai-pipeline-dashboard.plist

# 상태 확인
launchctl list | grep ai-pipeline
```

### Linux - systemd

```bash
# /etc/systemd/system/ai-pipeline-dashboard.service
```

```ini
[Unit]
Description=AI Pipeline Dashboard
After=network.target

[Service]
Type=simple
User=user
WorkingDirectory=/home/user/ai-pipeline/dashboard
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable ai-pipeline-dashboard
sudo systemctl start ai-pipeline-dashboard
sudo systemctl status ai-pipeline-dashboard
```

### PM2 (Node.js 프로세스 매니저)

```bash
# 설치
npm install -g pm2

# 시작
pm2 start server.js --name ai-pipeline-dashboard

# 자동 시작 설정
pm2 startup
pm2 save

# 상태 확인
pm2 status
pm2 logs ai-pipeline-dashboard
```

## Docker (선택)

### Dockerfile

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3030

CMD ["node", "server.js"]
```

### docker-compose.yml

```yaml
version: '3.8'
services:
  dashboard:
    build: ./dashboard
    ports:
      - "3030:3030"
    environment:
      - NODE_ENV=production
      - SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}
    volumes:
      - ./dashboard/jobs.json:/app/jobs.json
      - ./dashboard/logs:/app/logs
    restart: unless-stopped
```

```bash
docker-compose up -d
```

## 리버스 프록시 (Nginx)

```nginx
server {
    listen 80;
    server_name dashboard.example.com;

    location / {
        proxy_pass http://localhost:3030;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;

        # SSE 지원
        proxy_set_header X-Accel-Buffering no;
        proxy_buffering off;
    }
}
```

## 모니터링

### 헬스 체크

```bash
curl http://localhost:3030/api/health
```

```json
{
  "status": "ok",
  "uptime": 3600,
  "scheduledJobs": 15
}
```

### 로그 확인

```bash
# Express 서버 로그
tail -f /path/to/logs/server.log

# PM2 로그
pm2 logs ai-pipeline-dashboard

# Docker 로그
docker logs -f ai-pipeline-dashboard
```

### 알림 테스트

```bash
# Slack 웹훅 테스트
curl -X POST -H 'Content-type: application/json' \
  --data '{"text":"테스트 메시지"}' \
  YOUR_SLACK_WEBHOOK_URL
```

## 업데이트

### 코드 업데이트

```bash
cd ai-pipeline
git pull

cd dashboard
npm install

# 서비스 재시작
pm2 restart ai-pipeline-dashboard
# 또는
sudo systemctl restart ai-pipeline-dashboard
```

### 마이그레이션

jobs.json 구조 변경 시:
1. 기존 jobs.json 백업
2. 새 버전 업데이트
3. 필요시 jobs.json 마이그레이션

```bash
cp jobs.json jobs.json.backup
# 업데이트 후 검증
curl http://localhost:3030/api/jobs
```

## 트러블슈팅

### 포트 충돌

```bash
# 사용 중인 프로세스 확인
lsof -i :3030

# 다른 포트로 실행
PORT=3031 npm run web
```

### Python 스크립트 실행 실패

```bash
# venv 경로 확인
which python
# 예상: /Users/user/ai-pipeline/.venv/bin/python

# 권한 확인
ls -la scripts/*.py
chmod +x scripts/*.py
```

### Slack 알림 안 됨

1. Webhook URL 확인 (jobs.json > settings.slackWebhookUrl)
2. 네트워크 확인
3. Slack 앱 설정 확인

```bash
# 테스트
curl -X POST YOUR_WEBHOOK_URL -d '{"text":"test"}'
```

### Claude CLI 오류 (Electron)

```bash
# Claude CLI 설치 확인
claude --version

# PATH 확인
echo $PATH

# 수동 테스트
claude --print "테스트"
```

### Obsidian 저장 실패 (Electron)

1. config/settings.yaml의 vault.path 확인
2. 디렉토리 존재 및 권한 확인

```bash
ls -la ~/Documents/Obsidian/MyVault/DAILY/
```

## 보안 고려사항

### 네트워크 접근

- 기본적으로 localhost만 바인딩
- 외부 접근 시 리버스 프록시 + 인증 권장

### 민감 정보

- Slack Webhook URL
- AWS 자격증명 (CloudWatch 스크립트용)
- JIRA 토큰

환경변수 또는 별도 설정 파일로 관리:
```bash
# .env 파일은 .gitignore에 추가
echo ".env" >> .gitignore
```

### 실행 권한

- Python 스크립트 실행 시 주의
- 사용자 정의 명령어 검증 필요
