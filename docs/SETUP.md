# 설치 가이드

AI Pipeline을 처음 설정하는 분들을 위한 상세 가이드입니다.

## 목차

1. [요구사항](#요구사항)
2. [설치](#설치)
3. [설정](#설정)
4. [검증](#검증)
5. [트러블슈팅](#트러블슈팅)

## 요구사항

### 필수
- **Python 3.10+**
- **Obsidian** (또는 마크다운 지원 노트앱)
- **Gemini API 키** (무료)

### 선택
- **GitHub CLI (`gh`)** - GitHub 활동 동기화용
- **Quartz** - 웹으로 노트 공개할 때

### 요구사항 확인
```bash
# Python 버전 확인
python3 --version  # 3.10+ 필요

# GitHub CLI 확인 (선택)
gh --version
gh auth status
```

## 설치

### 1. 저장소 클론
```bash
# 홈 디렉토리에 설치 (권장)
cd ~
git clone https://github.com/your-username/ai-pipeline.git
cd ai-pipeline
```

### 2. Python 가상환경 설정
```bash
# 가상환경 생성
python3 -m venv .venv

# 가상환경 활성화
source .venv/bin/activate  # macOS/Linux
# .venv\Scripts\activate   # Windows

# 의존성 설치
pip install -r requirements.txt
```

### 3. API 키 발급

#### Gemini API (추천)
1. https://aistudio.google.com/apikey 접속
2. Google 계정으로 로그인
3. "Create API Key" 클릭
4. 키 복사

#### OpenAI API (대안)
1. https://platform.openai.com/api-keys 접속
2. "Create new secret key" 클릭

#### Anthropic API (대안)
1. https://console.anthropic.com/ 접속
2. API Keys에서 키 생성

## 설정

### 1. 설정 파일 생성
```bash
cp config/settings.example.yaml config/settings.local.yaml
```

### 2. 설정 파일 수정
`config/settings.local.yaml`을 열어서 수정:

```yaml
# Obsidian Vault 설정
vault:
  path: "/Users/yourname/Documents/Obsidian"  # ⬅️ 본인 경로로 변경
  target_folder: "study"
  drafts_folder: "study/_drafts"
  daily_folder: "DAILY"
  quizzes_folder: "study/_quizzes"

# LLM 설정
llm:
  provider: "gemini"  # gemini | openai | anthropic

# GitHub 저장소 (선택)
github:
  repos:
    - "/Users/yourname/Projects/my-project"  # ⬅️ 본인 경로로 변경
```

### 3. 환경변수 설정
`~/.zshrc` (또는 `~/.bashrc`)에 추가:

```bash
# AI Pipeline 환경변수
export GOOGLE_API_KEY="your-api-key-here"  # ⬅️ 발급받은 키로 변경

# (선택) OpenAI 사용 시
# export OPENAI_API_KEY="sk-..."

# (선택) Anthropic 사용 시
# export ANTHROPIC_API_KEY="sk-ant-..."
```

적용:
```bash
source ~/.zshrc
```

### 4. Shell 별칭 등록
`~/.zshrc`에 추가:

```bash
# AI Pipeline 별칭
source ~/ai-pipeline/scripts/aliases.sh
```

적용:
```bash
source ~/.zshrc
```

## 검증

### 설정 확인
```bash
python scripts/config.py
```

출력 예시:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧 AI Pipeline 설정
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   설정 파일: /Users/yourname/ai-pipeline/config/settings.local.yaml
   Vault: /Users/yourname/Documents/Obsidian
   Drafts: study/_drafts
   Daily: DAILY
   LLM: gemini (gemini-2.0-flash)
   GitHub Repos: 1개
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ 설정이 유효합니다.
```

### 명령어 테스트
```bash
# 도움말 확인
ai-help

# Quick note 테스트
quick "테스트 메모입니다"

# Daily Note 생성 테스트
daily-init
```

## 트러블슈팅

### "google-genai 패키지가 설치되지 않았습니다"
```bash
pip install google-genai
```

### "GOOGLE_API_KEY 환경변수가 설정되지 않았습니다"
```bash
# 환경변수 확인
echo $GOOGLE_API_KEY

# 설정 안되어 있으면 ~/.zshrc에 추가
export GOOGLE_API_KEY="your-key"
source ~/.zshrc
```

### "Vault 경로가 존재하지 않습니다"
```bash
# Obsidian vault 경로 확인
ls -la /Users/yourname/Documents/Obsidian

# 설정 파일의 vault.path 수정
```

### "command not found: quick"
```bash
# aliases.sh 로드 확인
source ~/ai-pipeline/scripts/aliases.sh

# ~/.zshrc에 추가했는지 확인
grep "aliases.sh" ~/.zshrc
```

### GitHub CLI 인증 오류
```bash
# GitHub 로그인
gh auth login

# 상태 확인
gh auth status
```

## 다음 단계

설치가 완료되었으면:

1. [명령어 가이드](COMMANDS.md) - 각 명령어 상세 사용법
2. [아키텍처](ARCHITECTURE.md) - 시스템 구조 이해
3. [README](../README.md) - 일일 워크플로우 참고
