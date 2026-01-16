#!/usr/bin/env python3
"""
AI Pipeline - Daily Sync
========================
오늘의 학습 노트를 Daily Note에 연결하는 스크립트

Usage:
    python daily.py              # 오늘의 drafts를 Daily Note에 추가
    python daily.py 2026-01-15   # 특정 날짜
    python daily.py --init       # 아침 템플릿 생성
    python daily.py --init 2026-01-15  # 특정 날짜 템플릿 생성
"""

import os
import sys
import yaml
import re
from pathlib import Path
from datetime import datetime, timedelta

# === Configuration ===

CONFIG_PATH = Path(__file__).parent.parent / "config" / "settings.yaml"


def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


CONFIG = load_config()


def _format_time_from_file(file: Path) -> str:
    """파일 수정 시간을 HH:MM으로 반환"""
    try:
        mtime = file.stat().st_mtime
    except OSError:
        return ""
    return datetime.fromtimestamp(mtime).strftime("%H:%M")


def get_today_drafts(target_date: str) -> list[dict]:
    """오늘 생성된 draft 노트들 조회"""
    vault_path = Path(CONFIG["vault"]["path"])
    drafts_folder = CONFIG["vault"].get("drafts_folder", "study/_drafts")
    drafts_path = vault_path / drafts_folder

    if not drafts_path.exists():
        return []

    drafts = []
    for file in drafts_path.glob(f"{target_date}_*.md"):
        # 파일 내용에서 title, summary 추출
        with open(file, "r", encoding="utf-8") as f:
            content = f.read()

        title = file.stem.replace(f"{target_date}_", "").replace("-", " ")
        summary = ""
        category = ""

        # Frontmatter 파싱
        if content.startswith("---"):
            end = content.find("---", 3)
            if end != -1:
                frontmatter = content[3:end]
                # title 추출
                title_match = re.search(r"title:\s*(.+)", frontmatter)
                if title_match:
                    title = title_match.group(1).strip()
                # category 추출
                cat_match = re.search(r"category:\s*(.+)", frontmatter)
                if cat_match:
                    category = cat_match.group(1).strip()

        # Summary 추출
        summary_match = re.search(r"## Summary\n(.+?)(?=\n---|\n##|\Z)", content, re.DOTALL)
        if summary_match:
            summary = summary_match.group(1).strip()[:100]

        drafts.append({
            "file": file,
            "filename": file.name,
            "title": title,
            "summary": summary,
            "category": category,
            "time": _format_time_from_file(file),
        })

    return drafts


def get_daily_note_path(target_date: str) -> Path:
    """Daily Note 경로 반환"""
    vault_path = Path(CONFIG["vault"]["path"])
    daily_folder = CONFIG["vault"].get("daily_folder", "DAILY")
    return vault_path / daily_folder / f"{target_date}.md"


def update_daily_note(target_date: str, drafts: list[dict]) -> str:
    """Daily Note에 오늘의 학습 섹션 추가/업데이트"""
    daily_path = get_daily_note_path(target_date)
    drafts_folder = CONFIG["vault"].get("drafts_folder", "study/_drafts")

    # 추가할 내용 생성
    learning_section = "\n## 🤖 오늘 배운 것 (AI 대화)\n"
    for draft in drafts:
        # Obsidian 링크 형식
        link = f"[[{drafts_folder}/{draft['filename'].replace('.md', '')}|{draft['title']}]]"
        category_badge = f"`{draft['category']}`" if draft['category'] else ""
        time_badge = f"`{draft['time']}`" if draft.get("time") else ""
        learning_section += f"- {time_badge} {category_badge} {link}\n"
        if draft['summary']:
            learning_section += f"  - {draft['summary'][:80]}...\n"

    learning_section += "\n"

    if daily_path.exists():
        # 기존 파일에 추가
        with open(daily_path, "r", encoding="utf-8") as f:
            content = f.read()

        # 이미 섹션이 있으면 교체, 없으면 추가
        if "## 🤖 오늘 배운 것" in content:
            # 기존 섹션 교체
            pattern = r"## 🤖 오늘 배운 것.*?(?=\n## |\Z)"
            content = re.sub(pattern, learning_section.strip(), content, flags=re.DOTALL)
        else:
            # 파일 끝에 추가
            content = content.rstrip() + "\n" + learning_section

        with open(daily_path, "w", encoding="utf-8") as f:
            f.write(content)
    else:
        # 새 파일 생성
        daily_path.parent.mkdir(parents=True, exist_ok=True)
        content = f"""# {target_date}

{learning_section}
## 📝 오늘의 생각


## ✅ 오늘 한 일

"""
        with open(daily_path, "w", encoding="utf-8") as f:
            f.write(content)

    return str(daily_path)


def get_weekday_korean(date_str: str) -> str:
    """요일 한글로 반환"""
    weekdays = ["월", "화", "수", "목", "금", "토", "일"]
    date_obj = datetime.strptime(date_str, "%Y-%m-%d")
    return weekdays[date_obj.weekday()]


def get_yesterday_date(target_date: str) -> str:
    """어제 날짜 반환"""
    date_obj = datetime.strptime(target_date, "%Y-%m-%d")
    yesterday = date_obj - timedelta(days=1)
    return yesterday.strftime("%Y-%m-%d")


def get_yesterday_note_content(target_date: str) -> tuple[str, list[str], list[str]]:
    """어제 Daily Note에서 미완료 할 일, 미해결 고민 추출"""
    yesterday = get_yesterday_date(target_date)
    yesterday_path = get_daily_note_path(yesterday)

    uncompleted_todos = []
    unresolved_concerns = []

    if not yesterday_path.exists():
        return yesterday, uncompleted_todos, unresolved_concerns

    with open(yesterday_path, "r", encoding="utf-8") as f:
        content = f.read()

    # 미완료 할 일 추출 (체크 안 된 것)
    todo_match = re.search(r"## 📋 할 일\s*\n(.*?)(?=\n## |\Z)", content, re.DOTALL)
    if todo_match:
        todo_section = todo_match.group(1)
        for line in todo_section.split("\n"):
            line = line.strip()
            # - [ ] 형식의 미완료 항목만
            if line.startswith("- [ ]") and len(line) > 6:
                uncompleted_todos.append(line)

    # 미해결 고민 추출 (내용이 있는 것)
    concern_match = re.search(r"## 🤔 고민거리\s*\n(.*?)(?=\n## |\Z)", content, re.DOTALL)
    if concern_match:
        concern_section = concern_match.group(1)
        # HTML 주석 제거
        concern_section = re.sub(r"<!--.*?-->", "", concern_section, flags=re.DOTALL)
        for line in concern_section.split("\n"):
            line = line.strip()
            if line.startswith("-") and len(line) > 2:
                unresolved_concerns.append(line)

    return yesterday, uncompleted_todos, unresolved_concerns


def get_daily_config() -> dict:
    """Daily 설정 조회"""
    return CONFIG.get("daily", {
        "link_yesterday": True,
        "carry_over_todos": True,
        "carry_over_concerns": True,
    })


def init_daily_note(target_date: str) -> str:
    """아침 템플릿 생성 (어제 링크 + 미완료 이월)"""
    daily_path = get_daily_note_path(target_date)
    weekday = get_weekday_korean(target_date)

    if daily_path.exists():
        print(f"⚠️  {target_date} Daily Note가 이미 존재합니다.")
        try:
            choice = input("덮어쓸까요? [y/N]: ").strip().lower()
        except EOFError:
            choice = "n"
        if choice not in ["y", "yes"]:
            return str(daily_path)

    daily_path.parent.mkdir(parents=True, exist_ok=True)

    # 설정 로드
    daily_config = get_daily_config()
    link_yesterday = daily_config.get("link_yesterday", True)
    carry_over_todos = daily_config.get("carry_over_todos", True)
    carry_over_concerns = daily_config.get("carry_over_concerns", True)

    # 어제 노트에서 정보 추출
    yesterday, uncompleted_todos, unresolved_concerns = get_yesterday_note_content(target_date)

    # 어제 링크 섹션
    yesterday_section = ""
    if link_yesterday:
        yesterday_section = f"\n> 📅 어제: [[{yesterday}]]\n"

    # 미완료 할 일
    todos_section = "- [ ]"
    if carry_over_todos and uncompleted_todos:
        todos_section = "\n".join(uncompleted_todos)
        print(f"   📋 어제 미완료 할 일 {len(uncompleted_todos)}개 이월")

    # 미해결 고민
    concerns_section = ""
    if carry_over_concerns and unresolved_concerns:
        concerns_section = "\n".join(unresolved_concerns)
        print(f"   🤔 어제 미해결 고민 {len(unresolved_concerns)}개 이월")

    content = f"""---
date: {target_date}
weekday: {weekday}요일
---

# {target_date} ({weekday})
{yesterday_section}
## 🎯 오늘의 Focus
<!-- 오늘 집중할 핵심 과제 1-2개 -->

-

## 📋 할 일
<!-- 오늘 해야 할 구체적인 태스크 -->

{todos_section}

## 🤔 고민거리
<!-- 현재 막혀있거나 결정이 필요한 것들 -->

{concerns_section}

## 📝 오늘의 생각
<!-- 하루 중 떠오르는 생각, 인사이트 -->



## ✅ 오늘 한 일
<!-- 퇴근 전에 정리 -->


"""
    with open(daily_path, "w", encoding="utf-8") as f:
        f.write(content)

    return str(daily_path)


def main():
    # --init 옵션 처리
    init_mode = "--init" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--init"]

    # 날짜 파라미터 처리
    if args:
        target_date = args[0]
    else:
        target_date = datetime.now().strftime("%Y-%m-%d")

    print(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"📅 Daily {'Init' if init_mode else 'Sync'}: {target_date}")
    print(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    # --init 모드: 아침 템플릿 생성
    if init_mode:
        result_path = init_daily_note(target_date)
        print(f"\n✅ Daily Note 템플릿 생성 완료!")
        print(f"   {result_path}")
        return

    # 오늘의 drafts 조회
    drafts = get_today_drafts(target_date)

    if not drafts:
        print(f"\n📭 {target_date}에 생성된 노트가 없습니다.")
        return

    print(f"\n🤖 오늘의 AI 대화 ({len(drafts)}건)")
    for i, draft in enumerate(drafts, 1):
        category = f"[{draft['category']}]" if draft['category'] else ""
        print(f"  {i}. {category} {draft['title']}")

    # 확인
    print(f"\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    daily_path = get_daily_note_path(target_date)
    exists = "업데이트" if daily_path.exists() else "생성"

    try:
        choice = input(f"\nDaily Note ({daily_path.name}) {exists}할까요? [Y/n]: ").strip().lower()
    except EOFError:
        choice = 'y'

    if choice in ['', 'y', 'yes']:
        result_path = update_daily_note(target_date, drafts)
        print(f"\n✅ Daily Note {exists} 완료!")
        print(f"   {result_path}")
    else:
        print("\n⏭️  건너뛰었습니다.")


if __name__ == "__main__":
    main()
