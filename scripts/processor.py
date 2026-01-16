#!/usr/bin/env python3
"""
AI Pipeline - Knowledge Processor
=================================
CLI AI 세션 로그를 분석하여 Obsidian Vault에 저장하는 ETL 스크립트

Usage:
    python processor.py <log_file_path>
    python processor.py --test  # 테스트 모드
"""

import os
import sys
import json
import yaml
import re
import shutil
from pathlib import Path
from datetime import datetime
from typing import Optional
from dataclasses import dataclass

# === TTY Input Helper ===
# script 명령어 등으로 stdin이 분리된 경우에도 터미널에서 입력받기 위함

def tty_input(prompt: str = "") -> str:
    """터미널에서 직접 입력받기 (stdin이 파이프여도 동작)"""
    try:
        # 먼저 /dev/tty 시도 (터미널 직접 접근)
        with open("/dev/tty", "r") as tty:
            if prompt:
                print(prompt, end="", flush=True)
            return tty.readline().strip()
    except (OSError, FileNotFoundError):
        # /dev/tty 없으면 일반 input 사용
        return input(prompt)


# === Configuration ===

CONFIG_PATH = Path(__file__).parent.parent / "config" / "settings.yaml"


def load_config() -> dict:
    """설정 파일 로드"""
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


CONFIG = load_config()

RAW_LOG_DATE_RE = re.compile(r"(20\d{2})[^\d]?(\d{2})[^\d]?(\d{2})")
PROMPT_BLOCK_RE = re.compile(r"(?m)^[ \t]*[❯›>]\s*(.+?)(?=^[ \t]*[❯›>]\s*|\Z)", re.DOTALL)

NOISE_SUBSTRINGS = [
    "contet left",
    "skills to list available skills",
    "for shortcuts",
    "esc to interrupt",
    "working(",
    "planning",
    "preparing",
    "exploring",
    "loading",
    "no matches",
    "initialized",
    "gradle",
    "daemon",
    "executing tests",
    "eecuting tests",
    "run with --scan",
]


def _get_raw_logs_root() -> Optional[Path]:
    raw_dir = CONFIG.get("pipeline", {}).get("raw_logs_dir")
    if not raw_dir:
        return None
    return Path(os.path.expandvars(os.path.expanduser(raw_dir)))


def _infer_log_date_from_name(filename: str) -> Optional[datetime]:
    match = RAW_LOG_DATE_RE.search(filename)
    if not match:
        return None
    try:
        return datetime(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def _is_relative_to(path: Path, base: Path) -> bool:
    try:
        path.relative_to(base)
        return True
    except ValueError:
        return False


def resolve_log_path(log_path: str) -> Path:
    """로그 경로 해석 (raw_logs_dir 및 날짜 폴더 지원)"""
    path = Path(log_path).expanduser()
    if path.exists():
        return path

    raw_root = _get_raw_logs_root()
    if not raw_root:
        return path

    candidate = raw_root / path
    if candidate.exists():
        return candidate

    log_date = _infer_log_date_from_name(path.name)
    if log_date:
        dated = raw_root / log_date.strftime("%Y") / log_date.strftime("%m") / log_date.strftime("%d") / path.name
        if dated.exists():
            return dated

    return path


def organize_raw_log(log_path: Path) -> Path:
    """raw 로그를 YYYY/MM/DD 폴더로 이동"""
    raw_root = _get_raw_logs_root()
    if not raw_root:
        return log_path

    try:
        resolved_path = log_path.resolve()
        raw_root_resolved = raw_root.resolve()
    except FileNotFoundError:
        return log_path

    if not _is_relative_to(resolved_path, raw_root_resolved):
        return log_path

    rel_parts = resolved_path.relative_to(raw_root_resolved).parts
    if (
        len(rel_parts) >= 4
        and re.fullmatch(r"\d{4}", rel_parts[0])
        and re.fullmatch(r"\d{2}", rel_parts[1])
        and re.fullmatch(r"\d{2}", rel_parts[2])
    ):
        return log_path

    log_date = _infer_log_date_from_name(log_path.name)
    if not log_date:
        try:
            log_date = datetime.fromtimestamp(log_path.stat().st_mtime)
        except OSError:
            return log_path

    dest_dir = raw_root_resolved / log_date.strftime("%Y") / log_date.strftime("%m") / log_date.strftime("%d")
    dest_dir.mkdir(parents=True, exist_ok=True)

    dest_path = dest_dir / log_path.name
    counter = 1
    while dest_path.exists():
        dest_path = dest_dir / f"{log_path.stem}_{counter}{log_path.suffix}"
        counter += 1

    try:
        shutil.move(str(log_path), str(dest_path))
    except OSError:
        return log_path

    print(f"       - raw 로그 이동: {dest_path}")
    return dest_path


# === Data Classes ===

@dataclass
class VaultContext:
    """Vault 컨텍스트 정보"""
    folders: list[str]
    files: list[str]
    tags: set[str]


@dataclass
class ProcessingDecision:
    """LLM의 처리 결정"""
    action: str  # "new" | "append" | "link"
    target_folder: str
    target_file: Optional[str]
    title: str
    tags: list[str]
    summary: str
    related_files: list[str]
    content: str


# === Vault Scanner ===

def scan_vault() -> VaultContext:
    """Obsidian Vault 구조 스캔"""
    vault_path = Path(CONFIG["vault"]["path"])
    target_folder = CONFIG["vault"]["target_folder"]
    target_path = vault_path / target_folder

    folders = []
    files = []
    tags = set()

    for root, dirs, filenames in os.walk(target_path):
        # 숨김 폴더 제외
        dirs[:] = [d for d in dirs if not d.startswith(".")]

        rel_path = Path(root).relative_to(target_path)
        if str(rel_path) != ".":
            folders.append(str(rel_path))

        for filename in filenames:
            if filename.endswith(".md"):
                file_path = Path(root) / filename
                files.append(str(file_path.relative_to(target_path)))

                # 파일에서 태그 추출
                try:
                    with open(file_path, "r", encoding="utf-8") as f:
                        content = f.read()
                        # YAML frontmatter에서 태그 추출
                        if content.startswith("---"):
                            end = content.find("---", 3)
                            if end != -1:
                                frontmatter = content[3:end]
                                if "tags:" in frontmatter:
                                    tag_match = re.findall(r"#?([\w-]+)", frontmatter.split("tags:")[1].split("\n")[0])
                                    tags.update(tag_match)
                        # 본문에서 태그 추출
                        inline_tags = re.findall(r"#([\w-]+)", content)
                        tags.update(inline_tags)
                except Exception:
                    pass

    return VaultContext(folders=folders, files=files, tags=tags)


# === LLM Clients ===

def get_llm_client():
    """설정에 따른 LLM 클라이언트 반환"""
    provider = CONFIG["llm"]["provider"]

    if provider == "gemini":
        return GeminiClient()
    elif provider == "openai":
        return OpenAIClient()
    elif provider == "anthropic":
        return AnthropicClient()
    else:
        raise ValueError(f"Unknown LLM provider: {provider}")


class GeminiClient:
    """Google Gemini API 클라이언트 (google.genai 패키지 사용)

    장점:
    - 2M tokens context window (4.5MB 로그도 한번에 처리 가능)
    - 가장 저렴한 비용
    """

    def __init__(self):
        try:
            from google import genai

            api_key = os.environ.get("GOOGLE_API_KEY")
            if not api_key:
                print("GOOGLE_API_KEY 환경변수가 설정되지 않았습니다.")
                sys.exit(1)

            self.client = genai.Client(api_key=api_key)
            self.model_name = CONFIG["llm"]["gemini"]["model"]
        except ImportError:
            print("google-genai 패키지가 설치되지 않았습니다.")
            print("pip install google-genai")
            sys.exit(1)

    def analyze(self, log_content: str, vault_context: VaultContext) -> ProcessingDecision:
        """로그 분석 및 처리 결정

        Gemini는 2M context를 지원하므로 전체 로그를 보낼 수 있음
        """
        from google.genai import types

        prompt = self._build_prompt(log_content, vault_context)

        # Gemini API 호출
        response = self.client.models.generate_content(
            model=self.model_name,
            contents=prompt,
            config=types.GenerateContentConfig(
                temperature=0.3,
                response_mime_type="application/json"
            )
        )

        result = json.loads(response.text)

        # 응답이 list인 경우 첫 번째 요소 사용
        if isinstance(result, list):
            result = result[0] if result else {}

        return self._parse_decision(result)

    def _build_prompt(self, log_content: str, vault_context: VaultContext) -> str:
        # Gemini는 1M context 지원 → 전체 로그 전송 가능 (최대 500K자)
        max_chars = 500000  # 약 500KB, 충분한 여유
        content_to_send = log_content[:max_chars] if len(log_content) > max_chars else log_content

        return f"""{SYSTEM_PROMPT}

## Vault 구조
폴더: {vault_context.folders[:20]}
기존 파일: {vault_context.files[:30]}
기존 태그: {list(vault_context.tags)[:30]}

## 세션 로그
```
{content_to_send}
```

위 세션 로그를 분석하여 JSON 형식으로 응답해주세요.

### 출력 품질 가이드
- 요약은 2~4문장, 맥락/의사결정/근거 포함
- 본문은 "핵심 내용 → 근거/예시 → 정리" 순서로 구조화
- 로그가 지저분해도 의미있는 부분만 뽑아서 정리"""

    def _parse_decision(self, result: dict) -> ProcessingDecision:
        return ProcessingDecision(
            action=result.get("action", "new"),
            target_folder=result.get("target_folder", "Inbox"),
            target_file=result.get("target_file"),
            title=result.get("title", "Untitled"),
            tags=result.get("tags", []),
            summary=result.get("summary", ""),
            related_files=result.get("related_files", []),
            content=result.get("content", "")
        )


class OpenAIClient:
    """OpenAI API 클라이언트"""

    def __init__(self):
        try:
            from openai import OpenAI
            self.client = OpenAI()  # OPENAI_API_KEY 환경변수 사용
            self.model = CONFIG["llm"]["openai"]["model"]
        except ImportError:
            print("openai 패키지가 설치되지 않았습니다. pip install openai")
            sys.exit(1)

    def analyze(self, log_content: str, vault_context: VaultContext) -> ProcessingDecision:
        """로그 분석 및 처리 결정"""
        prompt = self._build_prompt(log_content, vault_context)

        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt}
            ],
            response_format={"type": "json_object"},
            temperature=0.3
        )

        result = json.loads(response.choices[0].message.content)
        return self._parse_decision(result)

    def _build_prompt(self, log_content: str, vault_context: VaultContext) -> str:
        # 이미 추출된 대화이므로 최대 16000자 사용
        content_to_send = log_content[:16000] if len(log_content) > 16000 else log_content
        return f"""## Vault 구조
폴더: {vault_context.folders[:20]}
기존 파일: {vault_context.files[:30]}
기존 태그: {list(vault_context.tags)[:30]}

## 세션 로그 (핵심 대화)
```
{content_to_send}
```

위 세션 로그를 분석하여 JSON 형식으로 응답해주세요.

### 출력 품질 가이드
- 요약은 2~4문장, 맥락/의사결정/근거 포함
- 본문은 "핵심 내용 → 근거/예시 → 정리" 순서로 구조화
- 로그가 지저분해도 의미있는 부분만 뽑아서 정리"""

    def _parse_decision(self, result: dict) -> ProcessingDecision:
        return ProcessingDecision(
            action=result.get("action", "new"),
            target_folder=result.get("target_folder", "Inbox"),
            target_file=result.get("target_file"),
            title=result.get("title", "Untitled"),
            tags=result.get("tags", []),
            summary=result.get("summary", ""),
            related_files=result.get("related_files", []),
            content=result.get("content", "")
        )


class AnthropicClient:
    """Anthropic API 클라이언트"""

    def __init__(self):
        try:
            import anthropic
            self.client = anthropic.Anthropic()  # ANTHROPIC_API_KEY 환경변수 사용
            self.model = CONFIG["llm"]["anthropic"]["model"]
        except ImportError:
            print("anthropic 패키지가 설치되지 않았습니다. pip install anthropic")
            sys.exit(1)

    def analyze(self, log_content: str, vault_context: VaultContext) -> ProcessingDecision:
        """로그 분석 및 처리 결정"""
        prompt = self._build_prompt(log_content, vault_context)

        response = self.client.messages.create(
            model=self.model,
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            messages=[
                {"role": "user", "content": prompt}
            ]
        )

        # JSON 추출
        content = response.content[0].text
        json_match = re.search(r"\{[\s\S]*\}", content)
        if json_match:
            result = json.loads(json_match.group())
            return self._parse_decision(result)
        else:
            raise ValueError("LLM 응답에서 JSON을 찾을 수 없습니다.")

    def _build_prompt(self, log_content: str, vault_context: VaultContext) -> str:
        # 이미 추출된 대화이므로 최대 16000자 사용
        content_to_send = log_content[:16000] if len(log_content) > 16000 else log_content
        return f"""## Vault 구조
폴더: {vault_context.folders[:20]}
기존 파일: {vault_context.files[:30]}
기존 태그: {list(vault_context.tags)[:30]}

## 세션 로그 (마지막 대화)
```
{content_to_send}
```

위 세션 로그를 분석하여 JSON 형식으로 응답해주세요."""

    def _parse_decision(self, result: dict) -> ProcessingDecision:
        return ProcessingDecision(
            action=result.get("action", "new"),
            target_folder=result.get("target_folder", "Inbox"),
            target_file=result.get("target_file"),
            title=result.get("title", "Untitled"),
            tags=result.get("tags", []),
            summary=result.get("summary", ""),
            related_files=result.get("related_files", []),
            content=result.get("content", "")
        )


# === System Prompt ===

SYSTEM_PROMPT = """당신은 개발자의 AI 대화 세션을 분석하여 지식 베이스(Obsidian)에 저장하는 전문가입니다.

## 역할
1. 세션 로그에서 핵심 지식/학습 내용 추출
2. 기존 Vault 구조와 비교하여 최적의 저장 위치 결정
3. 적절한 태그와 연관 문서 식별

## 원칙
- UI 잡음/반복 텍스트/로그 메타는 무시하고, 실제 대화만 반영
- 사용자가 지시한 사항과 결정된 결론 역시 정리
- 과장 금지: 로그에 없는 내용은 추측하지 말 것
- 필요한 경우 "추정"이 아닌 "질문/열린 항목"으로 남길 것

## 응답 형식 (JSON)
{
    "action": "new" | "append",
    "target_folder": "저장할 폴더명 (예: Docker, Java, AI)",
    "target_file": "append일 경우 기존 파일 경로, new일 경우 null",
    "title": "문서 제목 (간결하고 명확하게)",
    "tags": ["tag1", "tag2"],
    "summary": "2-3문장 요약",
    "related_files": ["연관된 기존 파일명"],
    "content": "Markdown 형식의 본문 내용"
}

## 분류 기준
- Docker, container 관련 → Docker 폴더
- Java, Spring, JPA 관련 → Java 폴더
- Kafka, 메시지 큐 관련 → kafka 폴더
- AWS, 클라우드 관련 → aws 폴더
- 분류 불확실 → Inbox 폴더

## 주의사항
- 코드 블록은 언어 명시 (```java, ```python 등)
- 기존 문서와 중복되는 내용은 append 권장
- 태그는 기존 태그 재사용 우선
- 필요하다면, 태그 및 폴더를 추가
- 불필요한 대화(인사, 확인 등)는 제외
- 정보 손실은 최소화, 대화가 길고, 중요한 내용들이 있다면 길고 자세히 포함"""


# === File Writer ===

def write_to_vault(
    decision: ProcessingDecision,
    raw_log_path: Optional[Path] = None,
) -> str:
    """결정에 따라 Vault의 _drafts 폴더에 파일 작성

    모든 새 노트는 _drafts/에 먼저 저장됨 (staging)
    파일명: YYYY-MM-DD_제목.md
    """
    vault_path = Path(CONFIG["vault"]["path"])
    drafts_folder = CONFIG["vault"].get("drafts_folder", "study/_drafts")

    # drafts 폴더 생성
    folder_path = vault_path / drafts_folder
    folder_path.mkdir(parents=True, exist_ok=True)

    # 파일명 생성: 날짜_제목.md
    date_prefix = datetime.now().strftime('%Y-%m-%d')
    safe_title = re.sub(r'[\\/*?:"<>|]', "", decision.title)
    safe_title = safe_title.replace(' ', '-')[:50]  # 공백→하이픈, 50자 제한
    file_path = folder_path / f"{date_prefix}_{safe_title}.md"

    # 중복 파일명 처리
    counter = 1
    while file_path.exists():
        file_path = folder_path / f"{date_prefix}_{safe_title}_{counter}.md"
        counter += 1

    # 태그에 분류 폴더도 추가 (나중에 promote할 때 사용)
    all_tags = list(decision.tags)
    if decision.target_folder and decision.target_folder not in all_tags:
        all_tags.insert(0, decision.target_folder.lower())

    tags_str = ", ".join([f"{tag}" for tag in all_tags])
    related_str = ", ".join([f"[[{f}]]" for f in decision.related_files])

    # Frontmatter + Content 작성
    raw_log_value = str(raw_log_path) if raw_log_path else ""
    content = f"""---
title: {decision.title}
tags: [{tags_str}]
date: {datetime.now().strftime('%Y-%m-%d')}
category: {decision.target_folder}
status: draft
related: [{related_str}]
source: ai-session
raw_log: {raw_log_value}
---

## Summary
{decision.summary}

---
{decision.content}
"""

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)

    return str(file_path)


# === Log Parser ===

def extract_conversations(log_content: str) -> list[dict]:
    """로그에서 대화 세션들을 추출

    Claude CLI 로그 형식:
    - "❯" 또는 ">" 로 사용자 입력 시작
    - Claude 응답이 뒤따름
    """
    log_content = normalize_log_content(log_content)

    conversations = []

    matches = PROMPT_BLOCK_RE.findall(log_content)

    for match in matches:
        content = match.strip()
        if len(content) > 80:  # 너무 짧은 대화 제외
            lines = content.split("\n")
            question = lines[0].strip() if lines else ""
            conversations.append(
                {
                    "question": question,
                    "content": content,
                }
            )

    return conversations


def get_main_conversation(log_content: str) -> str:
    """로그에서 메인 대화 추출 (마지막 의미있는 대화)"""
    conversations = extract_conversations(log_content)

    if not conversations:
        # 대화 추출 실패시 마지막 부분 반환
        normalized = normalize_log_content(log_content)
        return normalized[-20000:] if len(normalized) > 20000 else normalized

    # 마지막 대화 (가장 최근)
    last_conv = conversations[-1]
    content = last_conv["content"]

    # 너무 길면 마지막 20000자
    if len(content) > 20000:
        content = content[-20000:]

    print(f"       - 추출된 대화: \"{last_conv['question'][:50]}...\"")
    return content


def clean_ansi(content: str) -> str:
    """ANSI escape 코드 제거"""
    content = re.sub(r'\x1b\[[0-9;]*m', '', content)
    content = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', content)
    content = re.sub(r'\x1b\[[\d;]*[A-Za-z]', '', content)
    return content


def _is_noise_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return True

    lower = stripped.lower()
    for token in NOISE_SUBSTRINGS:
        if token in lower:
            return True

    if stripped.startswith(("•", "└", "╭", "╰", "╮", "╯")):
        return True

    if re.fullmatch(r"[•\-\─\_\. ]{5,}", stripped):
        return True

    if len(stripped) >= 60 and len(set(stripped)) <= 8:
        return True

    return False


def normalize_log_content(content: str) -> str:
    """UI 노이즈 제거 및 기본 정리"""
    cleaned = clean_ansi(content)
    lines = cleaned.splitlines()
    filtered = [line for line in lines if not _is_noise_line(line)]
    return "\n".join(filtered).strip()






# === Main Pipeline ===

def _build_prompt_preview(llm, provider: str, log_content: str, vault_context: VaultContext) -> str:
    """LLM에 전달되는 프롬프트 미리보기 생성"""
    if not hasattr(llm, "_build_prompt"):
        return ""
    user_prompt = llm._build_prompt(log_content, vault_context)
    if provider == "gemini":
        return user_prompt
    return f"{SYSTEM_PROMPT}\n\n---\n\n{user_prompt}"


def process_log(log_path: str, show_prompt: bool = False) -> str:
    """메인 파이프라인: 로그 파일 처리"""
    resolved_path = resolve_log_path(log_path)
    if not resolved_path.exists():
        print(f"❌ 로그 파일을 찾을 수 없습니다: {log_path}")
        return ""

    organized_path = organize_raw_log(resolved_path)

    print(f"[1/4] 로그 파일 로드: {organized_path}")
    with open(organized_path, "r", encoding="utf-8", errors="ignore") as f:
        raw_content = f.read()

    print(f"       - 원본 크기: {len(raw_content):,} bytes")

    # LLM provider에 따라 처리 방식 결정
    provider = CONFIG["llm"]["provider"]

    if provider == "gemini":
        # Gemini: 1M context 지원 → 전체 로그 사용
        log_content = normalize_log_content(raw_content)
        print(f"       - Gemini 모드: 전체 로그 사용 ({len(log_content):,} bytes)")
    else:
        # OpenAI/Anthropic: context 제한 → 마지막 대화만 추출
        log_content = get_main_conversation(raw_content)
        print(f"       - 추출 크기: {len(log_content):,} bytes")

    if len(log_content.strip()) < 100:
        print("[SKIP] 로그 내용이 너무 짧습니다.")
        return ""

    print(f"[2/4] Vault 스캔 중...")
    vault_context = scan_vault()
    print(f"       - 폴더: {len(vault_context.folders)}개")
    print(f"       - 파일: {len(vault_context.files)}개")
    print(f"       - 태그: {len(vault_context.tags)}개")

    print(f"[3/4] LLM 분석 중... (provider: {provider})")
    llm = get_llm_client()

    if show_prompt:
        prompt_preview = _build_prompt_preview(llm, provider, log_content, vault_context)
        print("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        print("🧪 LLM Prompt Preview (dry-run)")
        print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
        print(prompt_preview)
        print("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        return ""

    decision = llm.analyze(log_content, vault_context)

    print(f"       - 액션: {decision.action}")
    print(f"       - 폴더: {decision.target_folder}")
    print(f"       - 제목: {decision.title}")
    print(f"       - 태그: {decision.tags}")

    # 저장 전 확인 (interactive mode)
    decision = confirm_before_save(decision)
    if decision is None:
        print("\n⏭️  저장을 건너뛰었습니다.")
        return ""

    print(f"\n[4/4] Vault에 저장 중...")
    saved_path = write_to_vault(
        decision,
        raw_log_path=organized_path,
    )
    print(f"       ✓ 저장 완료: {saved_path}")

    return saved_path


def confirm_before_save(decision: ProcessingDecision) -> Optional[ProcessingDecision]:
    """저장 전 확인 및 수정 프롬프트"""
    print("\n" + "━" * 50)
    print("📋 저장 미리보기")
    print("━" * 50)
    print(f"  제목: {decision.title}")
    print(f"  폴더: {decision.target_folder}/")
    print(f"  태그: {', '.join(['#' + t for t in decision.tags])}")
    print(f"  액션: {'새 파일 생성' if decision.action == 'new' else '기존 파일에 추가'}")
    print("━" * 50)
    print(f"\n📝 요약:\n{decision.summary[:200]}...")
    print("\n" + "━" * 50)

    while True:
        try:
            choice = tty_input("\n저장할까요? [Y/n/edit/show]: ").lower()
        except (EOFError, OSError):
            # Non-interactive mode (파이프 등)
            return decision

        if choice in ['', 'y', 'yes']:
            return decision

        elif choice in ['n', 'no', 'skip']:
            return None

        elif choice == 'edit':
            decision = edit_decision(decision)
            print("\n✏️  수정됨:")
            print(f"  제목: {decision.title}")
            print(f"  폴더: {decision.target_folder}/")
            print(f"  태그: {', '.join(['#' + t for t in decision.tags])}")

        elif choice == 'show':
            print("\n📄 전체 내용:")
            print("─" * 40)
            print(decision.content[:2000])
            if len(decision.content) > 2000:
                print(f"\n... ({len(decision.content) - 2000}자 더 있음)")
            print("─" * 40)

        else:
            print("  [Y] 저장 | [n] 건너뛰기 | [edit] 수정 | [show] 내용 보기")


def edit_decision(decision: ProcessingDecision) -> ProcessingDecision:
    """결정 수정 프롬프트"""
    print("\n✏️  수정 모드 (Enter로 현재 값 유지)")

    # 제목 수정
    new_title = tty_input(f"  제목 [{decision.title}]: ")
    if new_title:
        decision = ProcessingDecision(
            action=decision.action,
            target_folder=decision.target_folder,
            target_file=decision.target_file,
            title=new_title,
            tags=decision.tags,
            summary=decision.summary,
            related_files=decision.related_files,
            content=decision.content
        )

    # 폴더 수정
    print(f"  사용 가능한 폴더: AI, Docker, Java, kafka, aws, Redis, shell, Inbox, ...")
    new_folder = tty_input(f"  폴더 [{decision.target_folder}]: ")
    if new_folder:
        decision = ProcessingDecision(
            action=decision.action,
            target_folder=new_folder,
            target_file=decision.target_file,
            title=decision.title,
            tags=decision.tags,
            summary=decision.summary,
            related_files=decision.related_files,
            content=decision.content
        )

    # 태그 수정
    current_tags = ', '.join(decision.tags)
    new_tags = tty_input(f"  태그 [{current_tags}]: ")
    if new_tags:
        tags_list = [t.strip().lstrip('#') for t in new_tags.split(',')]
        decision = ProcessingDecision(
            action=decision.action,
            target_folder=decision.target_folder,
            target_file=decision.target_file,
            title=decision.title,
            tags=tags_list,
            summary=decision.summary,
            related_files=decision.related_files,
            content=decision.content
        )

    return decision


def test_mode():
    """테스트 모드: Vault 스캔 테스트"""
    print("=== Test Mode ===")
    print(f"Config path: {CONFIG_PATH}")
    print(f"Vault path: {CONFIG['vault']['path']}")

    vault_context = scan_vault()
    print(f"\n폴더 ({len(vault_context.folders)}개):")
    for folder in vault_context.folders[:10]:
        print(f"  - {folder}")

    print(f"\n파일 ({len(vault_context.files)}개):")
    for file in vault_context.files[:10]:
        print(f"  - {file}")

    print(f"\n태그 ({len(vault_context.tags)}개):")
    print(f"  {list(vault_context.tags)[:20]}")


if __name__ == "__main__":
    args = sys.argv[1:]
    show_prompt = False
    if "--show-prompt" in args:
        show_prompt = True
        args = [a for a in args if a != "--show-prompt"]

    if len(args) < 1:
        print("Usage: python processor.py <log_file_path>")
        print("       python processor.py --test")
        print("       python processor.py --show-prompt <log_file_path>")
        sys.exit(1)

    if args[0] == "--test":
        test_mode()
    else:
        process_log(args[0], show_prompt=show_prompt)
