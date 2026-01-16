# 기여 가이드

AI Pipeline에 기여해 주셔서 감사합니다! 🎉

## 기여 방법

### 버그 리포트
1. [Issues](https://github.com/your-username/ai-pipeline/issues)에서 기존 이슈 확인
2. 없으면 새 이슈 생성
3. 재현 방법, 기대 동작, 실제 동작 포함

### 기능 제안
1. Issues에 Feature Request 생성
2. 사용 사례와 기대 효과 설명
3. 논의 후 구현

### 코드 기여

#### 1. Fork & Clone
```bash
git clone https://github.com/your-username/ai-pipeline.git
cd ai-pipeline
```

#### 2. 브랜치 생성
```bash
git checkout -b feature/amazing-feature
```

#### 3. 개발 환경 설정
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

#### 4. 코드 작성
- 기존 코드 스타일 따르기
- 독스트링 작성
- 테스트 추가 (가능하면)

#### 5. 테스트
```bash
# 설정 확인
python scripts/config.py

# 각 명령어 테스트
quick "테스트"
daily-init
```

#### 6. 커밋 & Push
```bash
git add .
git commit -m "feat: 기능 설명"
git push origin feature/amazing-feature
```

#### 7. Pull Request
- PR 템플릿에 맞게 작성
- 변경 사항 설명
- 스크린샷 (UI 변경 시)

## 코드 스타일

### Python
- Python 3.10+ 문법 사용
- Type hints 사용
- 독스트링 작성 (Google style)

```python
def my_function(param: str) -> dict:
    """함수 설명.

    Args:
        param: 파라미터 설명

    Returns:
        반환값 설명
    """
    pass
```

### 커밋 메시지
```
feat: 새 기능 추가
fix: 버그 수정
docs: 문서 수정
refactor: 리팩토링
test: 테스트 추가
chore: 빌드, 설정 변경
```

## 프로젝트 구조

```
ai-pipeline/
├── config/           # 설정 파일
├── scripts/          # 메인 스크립트
├── docs/             # 문서
├── requirements.txt  # 의존성
└── README.md
```

### 새 명령어 추가 시
1. `scripts/`에 새 스크립트 생성
2. `aliases.sh`에 별칭 추가
3. `docs/COMMANDS.md` 문서화
4. `README.md` 명령어 목록에 추가

### 새 LLM Provider 추가 시
1. `processor.py`에 클라이언트 클래스 추가
2. `config/settings.example.yaml`에 설정 추가
3. `docs/SETUP.md`에 설정 방법 추가

## 질문이 있으시면

- Issues에 질문 남기기
- Discussion 활용

감사합니다! 🙏
