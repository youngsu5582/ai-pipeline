#!/usr/bin/env python3
"""
AI Pipeline - Document Vacuum
=============================
프로젝트 루트의 흩어진 MD 파일을 분석하여 docs/로 정리

Usage:
    python vacuum.py /path/to/project [--dry-run] [--auto] [--to-obsidian] [--json]

Examples:
    vacuum ~/Projects/my-project --dry-run    # 미리보기만
    vacuum ~/Projects/my-project --auto       # 확인 없이 즉시 실행
    vacuum ~/Projects/my-project --auto --to-obsidian  # 자동 실행 + Obsidian 복사
"""

import argparse
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

import yaml

# 프로젝트 루트에서 config 로드
CONFIG_PATH = Path(__file__).parent.parent / "config" / "settings.yaml"


def load_config() -> dict:
    """설정 파일 로드"""
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


CONFIG = load_config()

# 제외할 파일 패턴
EXCLUDE_PATTERNS = [
    "README*.md",
    "CLAUDE.md",
    "AGENTS.md",
    "LICENSE*.md",
    "CHANGELOG*.md",
    "CONTRIBUTING*.md",
]

# 제외할 디렉토리
EXCLUDE_DIRS = [
    "node_modules",
    "docs",
    ".claude",
    ".git",
    "target",
    "build",
    "dist",
    ".gradle",
    ".idea",
    "venv",
    ".venv",
]

# 문서 유형 분류 규칙 (패턴 -> 유형)
DOC_TYPE_RULES = {
    "spec": [
        r"명세",
        r"SPEC",
        r"##\s*변경\s*범위",
        r"인터페이스\s*정의",
        r"API\s*스펙",
        r"계약\s*정의",
    ],
    "implementation": [
        r"구현\s*계획",
        r"Task\s*\d+:",
        r"\*\*Path\*\*:",
        r"구현\s*상세",
        r"Implementation\s*Plan",
        r"##\s*구현\s*순서",
    ],
    "learning": [
        r"##\s*목차",
        r"완벽\s*정리",
        r"가이드",
        r"Deep\s*Dive",
        r"핵심\s*개념",
        r"##\s*학습",
        r"Tutorial",
    ],
    "issue": [
        r"PROJECT-KEY-\d+",
        r"버그\s*수정",
        r"문제\s*상황",
        r"이슈\s*분석",
        r"Bug\s*Fix",
        r"##\s*원인\s*분석",
    ],
    "testing": [
        r"E2E.*테스트",
        r"테스트\s*시나리오",
        r"테스트\s*계획",
        r"Test\s*Plan",
        r"테스트\s*케이스",
    ],
    "review": [
        r"리뷰",
        r"코드\s*리뷰",
        r"PR\s*리뷰",
        r"Code\s*Review",
    ],
}

# 대상 폴더 매핑
TARGET_FOLDERS = {
    "spec": "docs/specs",
    "implementation": "docs/implementation",
    "learning": "docs/learning",
    "issue": "docs/issues/drafts",
    "testing": "docs/testing",
    "review": "docs/reviews",
}

# 기술 스택 태그 규칙
TECH_TAGS = {
    "postgresql": [r"postgresql", r"postgres", r"prepared\s*statement", r"partition", r"pgvector"],
    "kafka": [r"kafka", r"consumer", r"producer", r"topic(?!s?\s*:)", r"partition"],
    "spring": [r"spring", r"@bean", r"@service", r"jpa", r"@transactional", r"springboot"],
    "aws": [r"aws", r"\bs3\b", r"lambda", r"cloudfront", r"\bec2\b", r"dynamodb"],
    "redis": [r"redis", r"cache", r"pub/sub"],
    "rabbitmq": [r"rabbitmq", r"amqp", r"message\s*queue"],
    "react": [r"react", r"component", r"hooks", r"\.tsx"],
    "docker": [r"docker", r"container", r"dockerfile", r"compose"],
    "java": [r"java", r"\.java", r"gradle", r"maven"],
    "typescript": [r"typescript", r"\.ts", r"type\s*:"],
}


def should_exclude_file(file_path: Path) -> bool:
    """파일 제외 여부 확인"""
    name = file_path.name

    for pattern in EXCLUDE_PATTERNS:
        if pattern.startswith("*"):
            if name.endswith(pattern[1:]):
                return True
        elif pattern.endswith("*"):
            if name.startswith(pattern[:-1]):
                return True
        elif "*" in pattern:
            import fnmatch
            if fnmatch.fnmatch(name, pattern):
                return True
        elif name == pattern:
            return True

    return False


def should_exclude_dir(dir_path: Path) -> bool:
    """디렉토리 제외 여부 확인"""
    parts = dir_path.parts
    return any(excluded in parts for excluded in EXCLUDE_DIRS)


def find_md_files(project_root: Path, recursive: bool = False) -> list[Path]:
    """프로젝트 루트에서 정리 대상 MD 파일 탐색

    Args:
        project_root: 탐색할 디렉토리 경로
        recursive: True면 하위 디렉토리도 재귀적으로 탐색
    """
    md_files = []

    if recursive:
        # 재귀적 탐색 (제외 디렉토리 제외)
        for md_file in project_root.rglob("*.md"):
            if should_exclude_dir(md_file.parent):
                continue
            if not should_exclude_file(md_file):
                md_files.append(md_file)
    else:
        # 현재 디렉토리만 탐색
        for md_file in project_root.glob("*.md"):
            if not should_exclude_file(md_file):
                md_files.append(md_file)

    return sorted(md_files, key=lambda f: f.stat().st_mtime, reverse=True)


def read_file_content(file_path: Path, max_chars: int = 10000) -> str:
    """파일 내용 읽기 (최대 문자 수 제한)"""
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return f.read(max_chars)
    except Exception as e:
        return ""


def extract_title(content: str, file_path: Path) -> str:
    """제목 추출"""
    # 첫 번째 # 헤더 찾기
    match = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
    if match:
        return match.group(1).strip()

    # 파일명에서 추출
    return file_path.stem.replace("-", " ").replace("_", " ").title()


def classify_doc_type(content: str) -> str:
    """문서 유형 분류"""
    content_lower = content.lower()

    scores = {doc_type: 0 for doc_type in DOC_TYPE_RULES}

    for doc_type, patterns in DOC_TYPE_RULES.items():
        for pattern in patterns:
            if re.search(pattern, content, re.IGNORECASE):
                scores[doc_type] += 1

    # 가장 높은 점수의 유형 반환
    max_score = max(scores.values())
    if max_score > 0:
        for doc_type, score in scores.items():
            if score == max_score:
                return doc_type

    return "learning"  # 기본값


def extract_tech_tags(content: str) -> list[str]:
    """기술 스택 태그 추출"""
    tags = []
    content_lower = content.lower()

    for tag, patterns in TECH_TAGS.items():
        for pattern in patterns:
            if re.search(pattern, content_lower, re.IGNORECASE):
                tags.append(tag)
                break

    return tags


def extract_summary(content: str, max_length: int = 200) -> str:
    """문서 요약 추출"""
    # frontmatter 제거
    content = re.sub(r"^---.*?---\s*", "", content, flags=re.DOTALL)

    # 첫 번째 헤더 이후 첫 단락 추출
    lines = content.strip().split("\n")
    summary_lines = []
    in_paragraph = False

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#"):
            if in_paragraph:
                break
            continue
        if stripped and not stripped.startswith(("```", "---", "|", "-", "*", ">")):
            summary_lines.append(stripped)
            in_paragraph = True
            if len(" ".join(summary_lines)) >= max_length:
                break
        elif in_paragraph and not stripped:
            break

    summary = " ".join(summary_lines)
    if len(summary) > max_length:
        summary = summary[:max_length] + "..."

    return summary


def normalize_filename(title: str, date: str) -> str:
    """파일명 정규화"""
    # 특수문자 제거, 공백을 하이픈으로
    normalized = re.sub(r"[^\w\s가-힣-]", "", title)
    normalized = re.sub(r"\s+", "-", normalized.strip())
    normalized = normalized.lower()

    # 너무 긴 파일명 줄이기
    if len(normalized) > 50:
        normalized = normalized[:50]

    return f"{date}_{normalized}.md"


def has_frontmatter(content: str) -> bool:
    """YAML frontmatter 존재 여부 확인"""
    return content.strip().startswith("---")


def create_frontmatter(title: str, doc_type: str, tags: list[str], original_file: str) -> str:
    """YAML frontmatter 생성"""
    today = datetime.now().strftime("%Y-%m-%d")

    frontmatter = f"""---
title: "{title}"
date: {today}
category: {doc_type}
tags: [{", ".join(tags)}]
source: claude-session
status: draft
original_file: {original_file}
---

"""
    return frontmatter


def analyze_file(file_path: Path) -> dict:
    """파일 분석"""
    content = read_file_content(file_path)

    title = extract_title(content, file_path)
    doc_type = classify_doc_type(content)
    tags = extract_tech_tags(content)
    summary = extract_summary(content)
    has_fm = has_frontmatter(content)

    today = datetime.now().strftime("%Y-%m-%d")
    new_filename = normalize_filename(title, today)
    target_folder = TARGET_FOLDERS.get(doc_type, "docs/learning")
    target_path = f"{target_folder}/{new_filename}"

    return {
        "original_path": str(file_path),
        "original_name": file_path.name,
        "title": title,
        "doc_type": doc_type,
        "tags": tags,
        "summary": summary,
        "target_path": target_path,
        "has_frontmatter": has_fm,
        "size_kb": round(file_path.stat().st_size / 1024, 1),
    }


def move_file(analysis: dict, project_root: Path, add_frontmatter: bool = True) -> bool:
    """파일 이동 및 frontmatter 추가"""
    original_path = Path(analysis["original_path"])
    target_path = project_root / analysis["target_path"]

    # 대상 폴더 생성
    target_path.parent.mkdir(parents=True, exist_ok=True)

    # 내용 읽기
    with open(original_path, "r", encoding="utf-8") as f:
        content = f.read()

    # frontmatter 추가 (없는 경우)
    if add_frontmatter and not analysis["has_frontmatter"]:
        frontmatter = create_frontmatter(
            analysis["title"],
            analysis["doc_type"],
            analysis["tags"],
            analysis["original_name"]
        )
        content = frontmatter + content

    # 대상 경로에 쓰기
    with open(target_path, "w", encoding="utf-8") as f:
        f.write(content)

    # 원본 삭제
    original_path.unlink()

    return True


def get_obsidian_path(analysis: dict) -> Path:
    """분석 결과에 따른 Obsidian 대상 경로 계산"""
    vault_path = Path(CONFIG["vault"]["path"])
    target_folder = CONFIG["vault"].get("target_folder", "study")

    # vacuum 설정에서 Obsidian 폴더 매핑 가져오기
    vacuum_config = CONFIG.get("vacuum", {})
    obsidian_folders = vacuum_config.get("obsidian_folders", {
        "spec": "projects/aicreation/specs",
        "implementation": "projects/aicreation/implementation",
        "learning": "projects/aicreation/learning",
        "issue": "projects/aicreation/issues",
        "testing": "projects/aicreation/testing",
        "review": "projects/aicreation/reviews",
    })

    category = analysis["doc_type"]
    relative_folder = obsidian_folders.get(category, "_inbox")
    obsidian_folder = vault_path / target_folder / relative_folder

    # 파일명 추출
    filename = Path(analysis["target_path"]).name
    return obsidian_folder / filename


def move_to_obsidian(analysis: dict, add_frontmatter: bool = True) -> Optional[str]:
    """원본 파일을 Obsidian vault로 직접 이동 (프로젝트에 남기지 않음)"""
    original_path = Path(analysis["original_path"])
    obsidian_path = get_obsidian_path(analysis)

    # 대상 폴더 생성
    obsidian_path.parent.mkdir(parents=True, exist_ok=True)

    # 내용 읽기
    with open(original_path, "r", encoding="utf-8") as f:
        content = f.read()

    # frontmatter 추가 (없는 경우)
    if add_frontmatter and not analysis["has_frontmatter"]:
        frontmatter = create_frontmatter(
            analysis["title"],
            analysis["doc_type"],
            analysis["tags"],
            analysis["original_name"]
        )
        content = frontmatter + content

    # Obsidian에 쓰기
    with open(obsidian_path, "w", encoding="utf-8") as f:
        f.write(content)

    # 원본 삭제
    original_path.unlink()

    return str(obsidian_path)


def copy_to_obsidian(analysis: dict, project_root: Path) -> Optional[str]:
    """Obsidian vault로 복사 (docs/에도 유지)"""
    obsidian_path = get_obsidian_path(analysis)
    obsidian_path.parent.mkdir(parents=True, exist_ok=True)

    # 소스 파일 경로 (이미 docs/로 이동된 파일)
    source_path = project_root / analysis["target_path"]

    if source_path.exists():
        shutil.copy2(source_path, obsidian_path)
        return str(obsidian_path)

    return None


def format_preview_markdown(analyses: list[dict]) -> str:
    """미리보기 마크다운 생성"""
    lines = ["# Vacuum 미리보기", "", f"## 발견된 파일 ({len(analyses)}개)", ""]

    for i, analysis in enumerate(analyses, 1):
        lines.extend([
            f"### {i}. {analysis['original_name']}",
            f"- [x] 처리",
            f"- **유형**: {analysis['doc_type']}",
            f"- **태그**: {', '.join(analysis['tags']) or '없음'}",
            f"- **대상**: `{analysis['target_path']}`",
            f"- **크기**: {analysis['size_kb']}KB",
            "",
            f"> {analysis['summary'][:200]}{'...' if len(analysis['summary']) > 200 else ''}",
            "",
            "---",
            ""
        ])

    lines.extend([
        "## 수정 방법",
        "코멘트로 수정 요청:",
        "- `title: 새 제목` - 제목 변경",
        "- `folder: docs/other/` - 대상 폴더 변경",
        "- `tags: +newtag` - 태그 추가",
        "- `skip` - 건너뛰기",
    ])

    return "\n".join(lines)


def format_result_report(moved: list[dict], skipped: list[dict], total: int) -> str:
    """결과 리포트 생성"""
    lines = [
        "# Vacuum 완료",
        "",
        "## 처리 결과",
        f"- 총 {total}개 파일 발견",
        f"- {len(moved)}개 파일 이동 완료",
        f"- {len(skipped)}개 파일 건너뜀",
        "",
    ]

    if moved:
        lines.extend(["## 이동된 파일", "", "| 원본 | 대상 | 유형 |", "|------|------|------|"])
        for item in moved:
            lines.append(f"| {item['original_name']} | {item['target_path']} | {item['doc_type']} |")
        lines.append("")

    lines.extend([
        "## 다음 단계",
        "- `git add docs/` 로 변경사항 스테이징",
        "- `vacuum --to-obsidian` 으로 Obsidian vault에도 복사 가능",
    ])

    return "\n".join(lines)


def prompt_confirmation(analyses: list[dict]) -> bool:
    """사용자 확인 프롬프트"""
    print(format_preview_markdown(analyses))
    print("\n" + "━" * 50)
    try:
        response = input("위 파일들을 정리하시겠습니까? [y/N]: ").strip().lower()
        return response in ("y", "yes")
    except (EOFError, KeyboardInterrupt):
        return False


def get_default_options() -> dict:
    """설정 파일에서 기본 옵션 로드"""
    vacuum_config = CONFIG.get("vacuum", {})
    defaults = vacuum_config.get("defaults", {})
    return {
        "auto": defaults.get("auto", False),
        "to_obsidian": defaults.get("to_obsidian", False),
    }


def main():
    # 설정 파일에서 기본값 로드
    defaults = get_default_options()

    parser = argparse.ArgumentParser(
        description="Document Vacuum - 흩어진 MD 파일 정리",
        epilog="기본값: --auto={}, --to-obsidian={} (settings.yaml에서 변경 가능)".format(
            defaults["auto"], defaults["to_obsidian"]
        )
    )
    parser.add_argument("project", nargs="?", default=".", help="프로젝트 루트 경로")
    parser.add_argument("--paths", help="쉼표로 구분된 추가 탐색 경로 (예: docs/specs,docs/issues)")
    parser.add_argument("--recursive", "-r", action="store_true", help="하위 디렉토리도 재귀적으로 탐색")
    parser.add_argument("--dry-run", action="store_true", help="실제 이동 없이 분석만")
    parser.add_argument("--auto", action="store_true", default=defaults["auto"],
                        help="확인 없이 즉시 실행 (기본: {})".format(defaults["auto"]))
    parser.add_argument("--no-auto", action="store_true", help="--auto 비활성화 (확인 받기)")
    parser.add_argument("--to-obsidian", action="store_true", default=defaults["to_obsidian"],
                        help="Obsidian vault로도 복사 (기본: {})".format(defaults["to_obsidian"]))
    parser.add_argument("--no-obsidian", action="store_true", help="--to-obsidian 비활성화")
    parser.add_argument("--json", action="store_true", help="JSON 형식으로 출력")
    parser.add_argument("--pattern", help="파일 패턴 (예: PostgreSQL*.md)")
    parser.add_argument("--exclude", help="쉼표로 구분된 제외 패턴 (예: README*.md,CHANGELOG*.md)")
    parser.add_argument("--quiet", "-q", action="store_true", help="최소 출력 (스크립트 연동용)")

    args = parser.parse_args()

    # --no-* 플래그로 기본값 오버라이드
    if args.no_auto:
        args.auto = False
    if args.no_obsidian:
        args.to_obsidian = False

    project_root = Path(args.project).resolve()

    if not project_root.exists():
        print(f"❌ 경로가 존재하지 않습니다: {project_root}")
        sys.exit(1)

    # 탐색할 경로 목록 구성
    search_paths = [project_root]

    # --paths 옵션으로 추가 경로 지정
    if args.paths:
        for path_str in args.paths.split(","):
            path_str = path_str.strip()
            if not path_str:
                continue
            # 상대 경로면 project_root 기준으로 해석
            if not path_str.startswith("/"):
                extra_path = project_root / path_str
            else:
                extra_path = Path(path_str)
            if extra_path.exists() and extra_path.is_dir():
                search_paths.append(extra_path.resolve())
            elif not args.quiet:
                print(f"⚠️  경로 없음: {path_str}")

    # MD 파일 탐색 (모든 경로에서)
    md_files = []
    seen_paths = set()  # 중복 방지

    for search_path in search_paths:
        for md_file in find_md_files(search_path, recursive=args.recursive):
            if md_file not in seen_paths:
                seen_paths.add(md_file)
                md_files.append(md_file)

    # 수정일 기준 정렬
    md_files.sort(key=lambda f: f.stat().st_mtime, reverse=True)

    # 패턴 필터링 (포함)
    if args.pattern:
        import fnmatch
        md_files = [f for f in md_files if fnmatch.fnmatch(f.name, args.pattern)]

    # 제외 패턴 필터링
    if args.exclude:
        import fnmatch
        exclude_patterns = [p.strip() for p in args.exclude.split(",") if p.strip()]
        filtered = []
        for f in md_files:
            excluded = False
            for pattern in exclude_patterns:
                if fnmatch.fnmatch(f.name, pattern):
                    excluded = True
                    break
            if not excluded:
                filtered.append(f)
        md_files = filtered

    if not md_files:
        if not args.quiet:
            print("📭 정리할 MD 파일이 없습니다.")
        sys.exit(0)

    # 파일 분석
    analyses = [analyze_file(f) for f in md_files]

    # JSON 출력
    if args.json:
        print(json.dumps(analyses, ensure_ascii=False, indent=2))
        sys.exit(0)

    # Dry-run: 미리보기만 출력
    if args.dry_run:
        print(format_preview_markdown(analyses))
        sys.exit(0)

    # 자동 모드가 아니면 확인 받기
    if not args.auto:
        if not prompt_confirmation(analyses):
            print("취소되었습니다.")
            sys.exit(0)

    # 실제 이동
    moved = []
    skipped = []

    if not args.quiet:
        print("━" * 50)
        print("🧹 Vacuum - 문서 정리 시작")
        print("━" * 50)

    for analysis in analyses:
        try:
            if args.to_obsidian:
                # Obsidian으로 직접 이동 (docs/에 남기지 않음)
                obsidian_path = move_to_obsidian(analysis)
                moved.append(analysis)
                if not args.quiet:
                    print(f"✅ {analysis['original_name']} → {obsidian_path}")
            else:
                # 기본: docs/로 이동
                move_file(analysis, project_root)
                moved.append(analysis)
                if not args.quiet:
                    print(f"✅ {analysis['original_name']} → {analysis['target_path']}")
        except Exception as e:
            skipped.append(analysis)
            if not args.quiet:
                print(f"❌ {analysis['original_name']}: {e}")

    if not args.quiet:
        print("━" * 50)
        print(f"\n{format_result_report(moved, skipped, len(analyses))}")
    else:
        # quiet 모드에서는 한 줄 요약만
        print(f"Vacuum: {len(moved)} moved, {len(skipped)} skipped")


if __name__ == "__main__":
    main()
