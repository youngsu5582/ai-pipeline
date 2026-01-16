#!/bin/bash
# ============================================
# Quartz 4.0 설치 및 설정 스크립트
# ============================================
#
# 이 스크립트는 Obsidian Vault에 Quartz를 설치하고
# 로컬 서버로 시각화할 수 있게 설정합니다.
#
# 사용법:
#   ./setup-quartz.sh                    # 설정에서 경로 읽기
#   ./setup-quartz.sh ~/my-vault         # 직접 경로 지정
#   AI_VAULT_PATH=~/my-vault ./setup-quartz.sh  # 환경변수 사용
#

set -e

# Vault 경로 결정 (우선순위: 인자 > 환경변수 > 설정파일 > 기본값)
if [[ -n "$1" ]]; then
    VAULT_PATH="$1"
elif [[ -n "$AI_VAULT_PATH" ]]; then
    VAULT_PATH="$AI_VAULT_PATH"
else
    # 설정 파일에서 읽기 시도
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    CONFIG_FILE="$SCRIPT_DIR/../config/settings.local.yaml"
    if [[ ! -f "$CONFIG_FILE" ]]; then
        CONFIG_FILE="$SCRIPT_DIR/../config/settings.yaml"
    fi
    if [[ -f "$CONFIG_FILE" ]]; then
        VAULT_PATH=$(grep "path:" "$CONFIG_FILE" | head -1 | sed 's/.*path:[[:space:]]*"//' | sed 's/".*//' | sed "s|~|$HOME|")
    fi
    # 기본값
    VAULT_PATH="${VAULT_PATH:-$HOME/Documents/Obsidian}"
fi

# ~ 확장
VAULT_PATH="${VAULT_PATH/#\~/$HOME}"

QUARTZ_PORT=8080

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔧 Quartz 4.0 Setup Script"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Node.js 버전 확인
if ! command -v node &> /dev/null; then
    echo "❌ Node.js가 설치되지 않았습니다."
    echo "   brew install node 또는 nvm install 20 실행"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [[ "$NODE_VERSION" -lt 18 ]]; then
    echo "❌ Node.js 18 이상이 필요합니다. (현재: v$NODE_VERSION)"
    exit 1
fi

echo "✅ Node.js: $(node -v)"
echo "✅ npm: $(npm -v)"
echo ""

# 이미 Quartz가 설치되어 있는지 확인
if [[ -f "$VAULT_PATH/quartz.config.ts" ]]; then
    echo "⚠️  Quartz가 이미 설치되어 있습니다."
    echo "   서버 시작: cd $VAULT_PATH && npx quartz build --serve"
    exit 0
fi

echo "📦 Quartz 설치 중..."
cd "$VAULT_PATH"

# Quartz clone
git clone https://github.com/jackyzha0/quartz.git quartz-temp
cp -r quartz-temp/* .
rm -rf quartz-temp

# 의존성 설치
npm install

echo ""
echo "✅ Quartz 설치 완료!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 다음 단계:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1. quartz.config.ts 수정 (아래 내용 참고)"
echo ""
echo "2. 서버 시작:"
echo "   cd $VAULT_PATH"
echo "   npx quartz build --serve --port $QUARTZ_PORT"
echo ""
echo "3. 브라우저에서 확인:"
echo "   http://localhost:$QUARTZ_PORT"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📄 quartz.config.ts 권장 설정:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
cat << 'EOF'

const config: QuartzConfig = {
  configuration: {
    pageTitle: "AI Knowledge Base",
    enableSPA: true,
    enablePopovers: true,
    analytics: null,
    locale: "ko-KR",
    baseUrl: "localhost",
    ignorePatterns: ["private", "templates", ".obsidian"],
    defaultDateType: "modified",
    theme: {
      fontOrigin: "googleFonts",
      cdnCaching: true,
      typography: {
        header: "Pretendard",
        body: "Pretendard",
        code: "JetBrains Mono",
      },
      // ...
    },
  },
  plugins: {
    transformers: [
      // Graph 설정
      Plugin.Graph({
        localGraph: {
          depth: 2,
        },
        globalGraph: {
          depth: 3,
        },
      }),
      // 태그 페이지
      Plugin.TagPage(),
      // 백링크
      Plugin.Backlinks(),
    ],
  },
}

EOF
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
