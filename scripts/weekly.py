#!/usr/bin/env python3
"""
AI Pipeline - Weekly Review
===========================
주간 학습 노트를 모아 주간 회고/퀴즈를 생성하는 스크립트

Usage:
    python weekly.py
    python weekly.py --date 2026-01-15
"""

import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import yaml


CONFIG_PATH = Path(__file__).parent.parent / "config" / "settings.yaml"


def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


CONFIG = load_config()


@dataclass
class WeeklyInputs:
    week_id: str
    start_date: str
    end_date: str
    draft_notes: list[dict]
    daily_notes: list[dict]
    quick_notes: list[dict]
    concerns: list[dict]  # Daily Notes의 고민거리


class GeminiClient:
    """Google Gemini API 클라이언트 (google.genai 패키지 사용)"""

    def __init__(self):
        try:
            from google import genai
        except ImportError:
            print("google-genai 패키지가 설치되지 않았습니다.")
            print("pip install google-genai")
            sys.exit(1)

        api_key = os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            print("GOOGLE_API_KEY 환경변수가 설정되지 않았습니다.")
            sys.exit(1)

        self.client = genai.Client(api_key=api_key)
        self.model_name = CONFIG["llm"]["gemini"]["model"]

    def analyze(self, prompt: str) -> dict:
        from google.genai import types

        response = self.client.models.generate_content(
            model=self.model_name,
            contents=prompt,
            config=types.GenerateContentConfig(
                temperature=0.3,
                response_mime_type="application/json",
            ),
        )

        raw_text = response.text or ""
        try:
            return json.loads(raw_text)
        except json.JSONDecodeError:
            match = re.search(r"\{[\s\S]*\}", raw_text)
            if match:
                return json.loads(match.group())
            raise


def parse_date(date_str: Optional[str]) -> datetime:
    if not date_str:
        return datetime.now()
    try:
        return datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        print("날짜 형식이 올바르지 않습니다. 예: 2026-01-15")
        sys.exit(1)


def get_week_context(target_date: datetime) -> tuple[str, list[str], str, str]:
    iso_year, iso_week, iso_weekday = target_date.isocalendar()
    week_start = target_date - timedelta(days=iso_weekday - 1)
    week_dates = [(week_start + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]
    week_id = f"{iso_year}-W{iso_week:02d}"
    return week_id, week_dates, week_dates[0], week_dates[-1]


def collect_notes(folder: Path, week_dates: list[str]) -> list[dict]:
    notes = []
    if not folder.exists():
        return notes

    date_set = set(week_dates)
    for file_path in sorted(folder.glob("*.md")):
        date_match = re.match(r"(\d{4}-\d{2}-\d{2})", file_path.name)
        if not date_match:
            continue
        if date_match.group(1) not in date_set:
            continue

        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        notes.append(
            {
                "path": file_path,
                "date": date_match.group(1),
                "content": content,
            }
        )
    return notes


def collect_quick_notes(folder: Path, week_dates: list[str]) -> list[dict]:
    """Quick Notes 수집"""
    notes = []
    if not folder.exists():
        return notes

    date_set = set(week_dates)
    for file_path in sorted(folder.glob("*_quick-notes.md")):
        date_match = re.match(r"(\d{4}-\d{2}-\d{2})", file_path.name)
        if not date_match:
            continue
        if date_match.group(1) not in date_set:
            continue

        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        # Notes 섹션만 추출
        notes_match = re.search(r"## Notes\s*\n(.*?)(?=\Z)", content, re.DOTALL)
        if notes_match:
            notes.append(
                {
                    "path": file_path,
                    "date": date_match.group(1),
                    "content": notes_match.group(1).strip(),
                }
            )
    return notes


def extract_concerns(daily_notes: list[dict]) -> list[dict]:
    """Daily Notes에서 고민거리/생각 추출"""
    concerns = []
    for note in daily_notes:
        content = note.get("content", "")

        # 고민거리 섹션
        concern_match = re.search(
            r"## 🤔 고민거리\s*\n(.*?)(?=\n## |\Z)", content, re.DOTALL
        )
        # 오늘의 생각 섹션
        thought_match = re.search(
            r"## 📝 오늘의 생각\s*\n(.*?)(?=\n## |\Z)", content, re.DOTALL
        )

        concern_text = concern_match.group(1).strip() if concern_match else ""
        thought_text = thought_match.group(1).strip() if thought_match else ""

        # HTML 주석 제거
        concern_text = re.sub(r"<!--.*?-->", "", concern_text, flags=re.DOTALL).strip()
        thought_text = re.sub(r"<!--.*?-->", "", thought_text, flags=re.DOTALL).strip()

        if concern_text or thought_text:
            concerns.append(
                {
                    "date": note.get("date", ""),
                    "concerns": concern_text,
                    "thoughts": thought_text,
                }
            )
    return concerns


def build_prompt(inputs: WeeklyInputs, vault_path: Path) -> str:
    drafts_block = []
    for note in inputs.draft_notes:
        rel_path = note["path"].relative_to(vault_path)
        drafts_block.append(
            f"### {note['date']} - {rel_path}\n```\n{note['content']}\n```"
        )

    daily_block = []
    for note in inputs.daily_notes:
        rel_path = note["path"].relative_to(vault_path)
        daily_block.append(
            f"### {note['date']} - {rel_path}\n```\n{note['content']}\n```"
        )

    quick_block = []
    for note in inputs.quick_notes:
        quick_block.append(f"### {note['date']}\n{note['content']}")

    concern_block = []
    for item in inputs.concerns:
        parts = []
        if item.get("concerns"):
            parts.append(f"고민: {item['concerns']}")
        if item.get("thoughts"):
            parts.append(f"생각: {item['thoughts']}")
        if parts:
            concern_block.append(f"### {item['date']}\n" + "\n".join(parts))

    drafts_text = "\n\n".join(drafts_block) if drafts_block else "없음"
    daily_text = "\n\n".join(daily_block) if daily_block else "없음"
    quick_text = "\n\n".join(quick_block) if quick_block else "없음"
    concern_text = "\n\n".join(concern_block) if concern_block else "없음"

    total_notes = len(inputs.draft_notes) + len(inputs.daily_notes) + len(inputs.quick_notes)

    return f"""당신은 개발자의 주간 학습과 성장을 분석하는 전문가입니다.

아래 노트를 분석해서 JSON만 반환하세요.

중요: 단순 "뭘 배웠다"가 아닌, **고민/상황/맥락**도 함께 분석하세요.
- Quick Notes에는 순간의 생각, 인사이트, 이슈가 태그와 함께 기록됨
- 고민/생각 섹션에는 그날의 어려움, 결정 과정이 담겨있음
- 이것들을 종합해서 "어떤 맥락에서 뭘 배웠는지" 파악

요구사항:
- 노트를 주제/카테고리로 그룹화
- 학습 내용 기반 복습 퀴즈 5개 생성
- 추가 학습 키워드 추천
- 고민/도전과 해결 과정 분석
- 성장 통계 생성

반환 JSON 형식:
{{
  "topics": [
    {{
      "category": "카테고리명",
      "summary": "핵심 요약",
      "notes": ["학습 포인트 1", "학습 포인트 2"]
    }}
  ],
  "challenges_and_learnings": [
    {{
      "challenge": "직면한 고민/도전",
      "context": "상황 맥락",
      "learning": "배운 점"
    }}
  ],
  "quiz_questions": [
    "질문 1",
    "질문 2",
    "질문 3",
    "질문 4",
    "질문 5"
  ],
  "additional_keywords": ["키워드1", "키워드2"],
  "growth_statistics": {{
    "total_notes": {total_notes},
    "draft_notes": {len(inputs.draft_notes)},
    "daily_notes": {len(inputs.daily_notes)},
    "quick_notes": {len(inputs.quick_notes)},
    "top_categories": ["카테고리1", "카테고리2"],
    "insights": ["성장 인사이트 1", "성장 인사이트 2"]
  }},
  "retrospective": {{
    "highlights": ["잘한 점 1", "잘한 점 2"],
    "challenges": ["어려웠던 점 1"],
    "next_steps": ["다음 주 행동 1", "다음 주 행동 2"]
  }}
}}

주간 정보:
- 주차: {inputs.week_id}
- 기간: {inputs.start_date} ~ {inputs.end_date}

## Draft Notes (AI 대화 정리)
{drafts_text}

## Daily Notes
{daily_text}

## Quick Notes (순간 기록, 태그 포함)
{quick_text}

## 고민/생각 (맥락 정보)
{concern_text}
"""


def build_retrospective_md(week_id: str, start_date: str, end_date: str, analysis: dict) -> str:
    topics = analysis.get("topics", [])
    quiz_questions = analysis.get("quiz_questions", [])
    keywords = analysis.get("additional_keywords", [])
    stats = analysis.get("growth_statistics", {})
    retrospective = analysis.get("retrospective", {})

    quick_notes = stats.get("quick_notes", 0)
    lines = [
        f"# {week_id} 회고",
        "",
        f"- 기간: {start_date} ~ {end_date}",
        f"- 노트 수: {stats.get('total_notes', 0)} (draft {stats.get('draft_notes', 0)}, daily {stats.get('daily_notes', 0)}, quick {quick_notes})",
        "",
        "## 주제별 정리",
    ]

    if topics:
        for topic in topics:
            category = topic.get("category", "기타")
            summary = topic.get("summary", "")
            notes = topic.get("notes", [])
            lines.append(f"### {category}")
            if summary:
                lines.append(f"- 요약: {summary}")
            for note in notes:
                lines.append(f"- {note}")
            lines.append("")
    else:
        lines.append("- 주간 주제 데이터가 없습니다.")
        lines.append("")

    lines.extend(
        [
            "## 성장 통계",
        ]
    )

    if stats:
        top_categories = stats.get("top_categories", [])
        insights = stats.get("insights", [])
        if top_categories:
            lines.append(f"- 주요 카테고리: {', '.join(top_categories)}")
        for insight in insights:
            lines.append(f"- {insight}")
    else:
        lines.append("- 성장 통계가 없습니다.")

    # 도전과 배움 섹션 (새로 추가)
    challenges_and_learnings = analysis.get("challenges_and_learnings", [])
    if challenges_and_learnings:
        lines.extend(
            [
                "",
                "## 🤔 도전과 배움",
            ]
        )
        for item in challenges_and_learnings:
            challenge = item.get("challenge", "")
            context = item.get("context", "")
            learning = item.get("learning", "")
            lines.append(f"### {challenge}")
            if context:
                lines.append(f"- **상황**: {context}")
            if learning:
                lines.append(f"- **배운 점**: {learning}")
            lines.append("")

    lines.extend(
        [
            "",
            "## 잘한 점",
        ]
    )
    for item in retrospective.get("highlights", []):
        lines.append(f"- {item}")
    if not retrospective.get("highlights"):
        lines.append("- 기록된 항목이 없습니다.")

    lines.extend(
        [
            "",
            "## 어려웠던 점",
        ]
    )
    for item in retrospective.get("challenges", []):
        lines.append(f"- {item}")
    if not retrospective.get("challenges"):
        lines.append("- 기록된 항목이 없습니다.")

    lines.extend(
        [
            "",
            "## 다음 주 액션",
        ]
    )
    for item in retrospective.get("next_steps", []):
        lines.append(f"- {item}")
    if not retrospective.get("next_steps"):
        lines.append("- 기록된 항목이 없습니다.")

    lines.extend(
        [
            "",
            "## 추가 학습 키워드",
        ]
    )
    if keywords:
        for keyword in keywords:
            lines.append(f"- {keyword}")
    else:
        lines.append("- 추천 키워드가 없습니다.")

    if quiz_questions:
        lines.extend(
            [
                "",
                "## 복습 퀴즈",
            ]
        )
        for idx, q in enumerate(quiz_questions, 1):
            lines.append(f"{idx}. {q}")

    lines.append("")
    return "\n".join(lines)


def build_quiz_md(week_id: str, quiz_questions: list[str]) -> str:
    lines = [
        f"# {week_id} Quiz",
        "",
        "## Questions",
    ]

    if quiz_questions:
        for idx, q in enumerate(quiz_questions, 1):
            lines.append(f"{idx}. {q}")
    else:
        lines.append("- 질문이 생성되지 않았습니다.")

    lines.append("")
    return "\n".join(lines)


def preview_contents(retro_md: str, quiz_md: str) -> None:
    print("\n" + "━" * 60)
    print("📋 주간 회고 미리보기")
    print("━" * 60)
    print(retro_md)
    print("\n" + "━" * 60)
    print("📝 주간 퀴즈 미리보기")
    print("━" * 60)
    print(quiz_md)
    print("\n" + "━" * 60)


def edit_contents(retro_md: str, quiz_md: str) -> tuple[str, str]:
    editor = os.environ.get("EDITOR", "vi")
    editor_cmd = shlex.split(editor)

    with tempfile.TemporaryDirectory() as tmpdir:
        retro_path = Path(tmpdir) / "weekly-retrospective.md"
        quiz_path = Path(tmpdir) / "weekly-quiz.md"
        retro_path.write_text(retro_md, encoding="utf-8")
        quiz_path.write_text(quiz_md, encoding="utf-8")

        subprocess.run(editor_cmd + [str(retro_path), str(quiz_path)], check=False)

        retro_updated = retro_path.read_text(encoding="utf-8")
        quiz_updated = quiz_path.read_text(encoding="utf-8")
        return retro_updated, quiz_updated


def confirm_and_save(
    retro_md: str,
    quiz_md: str,
    retro_path: Path,
    quiz_path: Path,
) -> bool:
    while True:
        preview_contents(retro_md, quiz_md)
        try:
            choice = input("파일을 저장할까요? [Y/n/edit]: ").strip().lower()
        except EOFError:
            choice = "y"

        if choice in ("", "y", "yes"):
            retro_path.parent.mkdir(parents=True, exist_ok=True)
            quiz_path.parent.mkdir(parents=True, exist_ok=True)
            retro_path.write_text(retro_md, encoding="utf-8")
            quiz_path.write_text(quiz_md, encoding="utf-8")
            return True
        if choice in ("n", "no", "skip"):
            return False
        if choice == "edit":
            retro_md, quiz_md = edit_contents(retro_md, quiz_md)
            continue

        print("  [Y] 저장 | [n] 건너뛰기 | [edit] 수정")


def main() -> None:
    date_arg = None
    if "--date" in sys.argv:
        idx = sys.argv.index("--date")
        if idx + 1 >= len(sys.argv):
            print("--date 옵션에는 날짜가 필요합니다. 예: --date 2026-01-15")
            sys.exit(1)
        date_arg = sys.argv[idx + 1]
    elif len(sys.argv) > 1:
        date_arg = sys.argv[1]

    target_date = parse_date(date_arg)
    week_id, week_dates, start_date, end_date = get_week_context(target_date)

    vault_path = Path(CONFIG["vault"]["path"])
    drafts_folder = CONFIG["vault"].get("drafts_folder", "study/_drafts")
    daily_folder = CONFIG["vault"].get("daily_folder", "DAILY")
    quizzes_folder = CONFIG["vault"].get("quizzes_folder", "study/_quizzes")

    drafts_path = vault_path / drafts_folder
    daily_path = vault_path / daily_folder

    draft_notes = collect_notes(drafts_path, week_dates)
    daily_notes = collect_notes(daily_path, week_dates)
    quick_notes = collect_quick_notes(drafts_path, week_dates)
    concerns = extract_concerns(daily_notes)

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"📅 Weekly Review: {week_id}")
    print(f"   기간: {start_date} ~ {end_date}")
    print(f"   Draft Notes: {len(draft_notes)}")
    print(f"   Daily Notes: {len(daily_notes)}")
    print(f"   Quick Notes: {len(quick_notes)}")
    print(f"   고민/생각: {len(concerns)}")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    if not draft_notes and not daily_notes and not quick_notes:
        print("\n📭 해당 주의 노트가 없습니다.")
        return

    inputs = WeeklyInputs(
        week_id=week_id,
        start_date=start_date,
        end_date=end_date,
        draft_notes=draft_notes,
        daily_notes=daily_notes,
        quick_notes=quick_notes,
        concerns=concerns,
    )

    prompt = build_prompt(inputs, vault_path)
    llm = GeminiClient()
    analysis = llm.analyze(prompt)

    retro_md = build_retrospective_md(week_id, start_date, end_date, analysis)
    quiz_md = build_quiz_md(week_id, analysis.get("quiz_questions", []))

    retrospective_path = vault_path / daily_folder / f"{week_id}-회고.md"
    quiz_path = vault_path / quizzes_folder / f"{week_id}-quiz.md"

    saved = confirm_and_save(retro_md, quiz_md, retrospective_path, quiz_path)
    if saved:
        print(f"\n✅ 저장 완료:")
        print(f"   {retrospective_path}")
        print(f"   {quiz_path}")
    else:
        print("\n⏭️  저장을 건너뛰었습니다.")


if __name__ == "__main__":
    main()
