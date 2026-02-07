#!/usr/bin/env python3
"""
AI Pipeline - GitHub Activity Sync
===================================
GitHub 활동(커밋, 리뷰, 코멘트)을 수집하여 Daily Note에 추가

Usage:
    python sync_github.py           # 어제 활동
    python sync_github.py --today   # 오늘 활동
    python sync_github.py 2026-01-15  # 특정 날짜

Requirements:
    - gh CLI 설치 및 인증 필요 (gh auth login)
"""

import json
import re
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import yaml

CONFIG_PATH = Path(__file__).parent.parent / "config" / "settings.yaml"


def load_config() -> dict:
    """설정 파일 로드 (우선순위 적용)"""
    config_files = [
        CONFIG_PATH.parent / "settings.local.yaml",
        CONFIG_PATH,
        CONFIG_PATH.parent / "settings.example.yaml",
    ]
    for config_file in config_files:
        if config_file.exists():
            with open(config_file, "r", encoding="utf-8") as f:
                return yaml.safe_load(f)
    return {}


CONFIG = load_config()


def get_jira_config() -> dict:
    """Jira 설정 조회"""
    sync_config = CONFIG.get("sync", {})
    return sync_config.get("jira", {})


def linkify_jira_tickets(text: str) -> str:
    """커밋 메시지에서 Jira 티켓 번호를 링크로 변환

    예: PROJECT-KEY-496 -> [PROJECT-KEY-496](https://jira.../browse/PROJECT-KEY-496)
    """
    jira_config = get_jira_config()
    jira_server = jira_config.get("server", "")

    if not jira_server:
        return text

    # Jira 티켓 패턴: 대문자-숫자 (예: PROJECT-KEY-496, PROJ-123)
    pattern = r'\b([A-Z][A-Z0-9]+-\d+)\b'

    def replace_ticket(match):
        ticket = match.group(1)
        url = f"{jira_server.rstrip('/')}/browse/{ticket}"
        return f"[{ticket}]({url})"

    return re.sub(pattern, replace_ticket, text)


def get_github_config() -> dict:
    """GitHub sync 설정 조회"""
    sync_config = CONFIG.get("sync", {})
    github_config = sync_config.get("github", {})

    if not github_config:
        print("❌ GitHub sync 설정이 없습니다.")
        print("   config/settings.local.yaml에 sync.github 설정을 추가하세요.")
        sys.exit(1)

    if not github_config.get("enabled", True):
        print("⚠️  GitHub sync가 비활성화되어 있습니다.")
        print("   config/settings.local.yaml에서 sync.github.enabled: true로 설정하세요.")
        sys.exit(0)

    return github_config


def run_gh_command(args: list[str]) -> Optional[str]:
    """gh CLI 명령 실행"""
    try:
        result = subprocess.run(
            ["gh"] + args,
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        print(f"⚠️  gh 명령 실패: {e.stderr}")
        return None
    except FileNotFoundError:
        print("❌ gh CLI가 설치되어 있지 않습니다.")
        print("   brew install gh && gh auth login")
        sys.exit(1)


def get_username() -> str:
    """현재 GitHub 사용자명 조회"""
    result = run_gh_command(["api", "user", "-q", ".login"])
    if not result:
        print("❌ GitHub 인증이 필요합니다. gh auth login 실행하세요.")
        sys.exit(1)
    return result


def get_user_events(username: str, target_date: str) -> list[dict]:
    """특정 날짜의 사용자 이벤트 조회"""
    result = run_gh_command(["api", f"users/{username}/events", "--paginate"])
    if not result:
        return []

    try:
        events = json.loads(result)
    except json.JSONDecodeError:
        return []

    # 해당 날짜 이벤트만 필터링
    filtered = []
    for event in events:
        created_at = event.get("created_at", "")
        if created_at.startswith(target_date):
            filtered.append(event)

    return filtered


def get_git_user_info(repo_path: Path) -> tuple[str, str]:
    """로컬 git config에서 user.name, user.email 조회"""
    try:
        name_result = subprocess.run(
            ["git", "-C", str(repo_path), "config", "user.name"],
            capture_output=True,
            text=True,
        )
        email_result = subprocess.run(
            ["git", "-C", str(repo_path), "config", "user.email"],
            capture_output=True,
            text=True,
        )
        return name_result.stdout.strip(), email_result.stdout.strip()
    except Exception:
        return "", ""


def get_commit_branches(repo_path: Path, sha: str) -> list[str]:
    """커밋이 속한 브랜치 목록 조회"""
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_path), "branch", "-a", "--contains", sha],
            capture_output=True,
            text=True,
        )
        branches = []
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            # "* main" 또는 "  feature/xxx" 형식
            branch = line.strip().lstrip("* ")
            # remotes/origin/xxx -> origin/xxx 제거 (로컬 브랜치만)
            if branch.startswith("remotes/"):
                continue
            branches.append(branch)
        return branches
    except Exception:
        return []


def get_git_remote_url(repo_path: Path) -> str:
    """git remote URL에서 GitHub URL 추출"""
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_path), "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
        )
        url = result.stdout.strip()
        # SSH 형식: git@github.com:owner/repo.git
        # HTTPS 형식: https://github.com/owner/repo.git
        if url.startswith("git@"):
            # git@github.com:owner/repo.git -> https://github.com/owner/repo
            match = re.match(r"git@([^:]+):(.+?)(?:\.git)?$", url)
            if match:
                return f"https://{match.group(1)}/{match.group(2)}"
        elif url.startswith("https://"):
            return url.replace(".git", "")
        return ""
    except Exception:
        return ""


def get_repo_owner_name(remote_url: str) -> tuple[str, str]:
    """GitHub URL에서 owner/repo 추출

    예: https://github.com/owner/repo -> (owner, repo)
    """
    if not remote_url:
        return "", ""
    match = re.match(r"https://[^/]+/([^/]+)/([^/]+)/?", remote_url)
    if match:
        return match.group(1), match.group(2)
    return "", ""


def get_commit_pr(owner: str, repo: str, sha: str) -> Optional[dict]:
    """커밋이 속한 PR 조회 (GitHub API)

    Returns:
        PR 정보 dict (number, title, url) 또는 None
    """
    if not owner or not repo or not sha:
        return None

    result = run_gh_command([
        "api",
        f"repos/{owner}/{repo}/commits/{sha}/pulls",
        "--jq", ".[0] | {number, title, html_url}"
    ])

    if not result or result == "null":
        return None

    try:
        pr_data = json.loads(result)
        if pr_data and pr_data.get("number"):
            return {
                "number": pr_data.get("number"),
                "title": pr_data.get("title", ""),
                "url": pr_data.get("html_url", ""),
            }
    except json.JSONDecodeError:
        pass

    return None


def get_commits_from_repos(username: str, target_date: str, override_repos: list[str] = None) -> list[dict]:
    """git log로 로컬 커밋 수집 (시간, GitHub URL 포함)

    Args:
        override_repos: CLI에서 지정한 저장소 경로 목록 (지정 시 settings.yaml 무시)
    """
    commits = []

    # 설정된 repos 경로들에서 커밋 조회
    if override_repos:
        repos_config = override_repos
    else:
        github_config = get_github_config()
        repos_config = github_config.get("repos", [])

    for repo_path in repos_config:
        repo = Path(repo_path).expanduser()
        if not (repo / ".git").exists():
            continue

        # 로컬 git user 정보로 author 필터링
        git_name, git_email = get_git_user_info(repo)
        # GitHub URL 가져오기
        remote_url = get_git_remote_url(repo)
        # owner/repo 추출 (PR 조회용)
        owner, repo_name = get_repo_owner_name(remote_url)

        try:
            # 모든 브랜치에서 해당 날짜의 커밋 조회
            # --all: 모든 브랜치, --no-merges: 머지 커밋 제외
            cmd = [
                "git",
                "-C",
                str(repo),
                "log",
                "--all",
                "--no-merges",
                "--since",
                f"{target_date} 00:00:00",
                "--until",
                f"{target_date} 23:59:59",
                "--format=%H|%s|%an|%ae|%aI",  # %aI: ISO 8601 format
                "--date=iso",
            ]

            # author 필터: git config의 name 또는 email 사용
            if git_email:
                cmd.extend(["--author", git_email])
            elif git_name:
                cmd.extend(["--author", git_name])
            # 둘 다 없으면 모든 커밋 수집

            result = subprocess.run(cmd, capture_output=True, text=True)

            # 먼저 커밋 기본 정보 수집
            repo_commits_raw = []
            for line in result.stdout.strip().split("\n"):
                if not line:
                    continue
                parts = line.split("|")
                if len(parts) >= 2:
                    full_sha = parts[0]
                    # 시간 추출 (ISO format: 2026-01-16T14:30:00+09:00)
                    time_str = ""
                    if len(parts) >= 5:
                        try:
                            dt = datetime.fromisoformat(parts[4])
                            time_str = dt.strftime("%H:%M")
                        except ValueError:
                            pass

                    repo_commits_raw.append({
                        "full_sha": full_sha,
                        "message": parts[1],
                        "author": parts[2] if len(parts) > 2 else username,
                        "time": time_str,
                    })

            # 커밋별로 브랜치/PR 정보 조회 (진행 상황 표시)
            total = len(repo_commits_raw)
            for idx, commit_raw in enumerate(repo_commits_raw, 1):
                full_sha = commit_raw["full_sha"]

                # 진행 상황 표시
                print(f"\r   🔍 {repo.name}: PR 정보 조회 중... ({idx}/{total})", end="", flush=True)

                # 브랜치 정보 조회
                branches = get_commit_branches(repo, full_sha)

                # PR 정보 조회 (GitHub API)
                pr_info = get_commit_pr(owner, repo_name, full_sha)

                commits.append(
                    {
                        "repo": repo.name,
                        "sha": full_sha[:7],
                        "full_sha": full_sha,
                        "message": commit_raw["message"],
                        "author": commit_raw["author"],
                        "time": commit_raw["time"],
                        "url": f"{remote_url}/commit/{full_sha}" if remote_url else "",
                        "repo_url": remote_url,
                        "branches": branches,
                        "pr": pr_info,
                    }
                )

            if repo_commits_raw:
                print()  # 줄바꿈
        except Exception:
            continue

    # 시간순 정렬
    commits.sort(key=lambda x: x.get("time", ""), reverse=False)
    return commits


def parse_time(iso_string: str) -> str:
    """ISO 8601 시간 문자열에서 HH:MM 추출"""
    if not iso_string:
        return ""
    try:
        # 2026-01-16T14:30:00Z 형식
        dt = datetime.fromisoformat(iso_string.replace("Z", "+00:00"))
        # UTC -> 로컬 시간으로 변환 (간단히 +9시간)
        from datetime import timezone, timedelta as td
        kst = timezone(td(hours=9))
        dt_kst = dt.astimezone(kst)
        return dt_kst.strftime("%H:%M")
    except ValueError:
        return ""


def parse_events(events: list[dict]) -> dict:
    """이벤트를 타입별로 분류 (시간, URL 포함)"""
    result = {
        "commits": [],
        "reviews": [],
        "comments": [],
        "prs": [],
        "issues": [],
    }

    for event in events:
        event_type = event.get("type", "")
        repo_full = event.get("repo", {}).get("name", "")  # owner/repo
        repo = repo_full.split("/")[-1]
        payload = event.get("payload", {})
        created_at = event.get("created_at", "")
        time_str = parse_time(created_at)
        repo_url = f"https://github.com/{repo_full}" if repo_full else ""

        if event_type == "PushEvent":
            for commit in payload.get("commits", []):
                full_sha = commit.get("sha", "")
                result["commits"].append(
                    {
                        "repo": repo,
                        "sha": full_sha[:7],
                        "full_sha": full_sha,
                        "message": commit.get("message", "").split("\n")[0],
                        "time": time_str,
                        "url": f"{repo_url}/commit/{full_sha}" if repo_url else "",
                        "repo_url": repo_url,
                    }
                )

        elif event_type == "PullRequestReviewEvent":
            review = payload.get("review", {})
            pr = payload.get("pull_request", {})
            pr_number = pr.get("number")
            # 리뷰 직접 링크
            review_url = review.get("html_url", "")
            result["reviews"].append(
                {
                    "repo": repo,
                    "pr_number": pr_number,
                    "pr_title": pr.get("title", ""),
                    "state": review.get("state", ""),
                    "body": (review.get("body") or "")[:200],
                    "time": time_str,
                    "url": f"{repo_url}/pull/{pr_number}" if repo_url and pr_number else "",
                    "review_url": review_url,
                    "repo_url": repo_url,
                }
            )

        elif event_type == "PullRequestReviewCommentEvent":
            comment = payload.get("comment", {})
            pr = payload.get("pull_request", {})
            pr_number = pr.get("number")
            # 코멘트 직접 링크
            comment_url = comment.get("html_url", "")
            result["comments"].append(
                {
                    "repo": repo,
                    "pr_number": pr_number,
                    "pr_title": pr.get("title", ""),
                    "body": (comment.get("body") or "")[:200],
                    "path": comment.get("path", ""),
                    "time": time_str,
                    "url": f"{repo_url}/pull/{pr_number}" if repo_url and pr_number else "",
                    "comment_url": comment_url,
                    "repo_url": repo_url,
                    "type": "pr_comment",
                }
            )

        elif event_type == "IssueCommentEvent":
            comment = payload.get("comment", {})
            issue = payload.get("issue", {})
            issue_number = issue.get("number")
            # PR인지 Issue인지 구분
            is_pr = "pull_request" in issue
            # 코멘트 직접 링크
            comment_url = comment.get("html_url", "")
            result["comments"].append(
                {
                    "repo": repo,
                    "issue_number": issue_number,
                    "pr_number": issue_number if is_pr else None,
                    "issue_title": issue.get("title", ""),
                    "pr_title": issue.get("title", "") if is_pr else "",
                    "body": (comment.get("body") or "")[:200],
                    "time": time_str,
                    "url": f"{repo_url}/{'pull' if is_pr else 'issues'}/{issue_number}" if repo_url else "",
                    "comment_url": comment_url,
                    "repo_url": repo_url,
                    "type": "pr_comment" if is_pr else "issue_comment",
                }
            )

        elif event_type == "PullRequestEvent":
            pr = payload.get("pull_request", {})
            action = payload.get("action", "")
            pr_number = pr.get("number")
            if action in ["opened", "closed", "merged"]:
                result["prs"].append(
                    {
                        "repo": repo,
                        "number": pr_number,
                        "title": pr.get("title", ""),
                        "action": action,
                        "merged": pr.get("merged", False),
                        "time": time_str,
                        "url": f"{repo_url}/pull/{pr_number}" if repo_url and pr_number else "",
                        "repo_url": repo_url,
                    }
                )

    return result


def clean_markdown_body(text: str, max_length: int = 100) -> str:
    """마크다운 본문 정리 (HTML, 이미지 제거)"""
    if not text:
        return ""

    # HTML 태그 제거
    text = re.sub(r"<[^>]+>", "", text)
    # 이미지 마크다운 제거
    text = re.sub(r"!\[.*?\]\(.*?\)", "[이미지]", text)
    # 링크는 텍스트만 남기기
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    # 연속 공백/줄바꿈 정리
    text = re.sub(r"\s+", " ", text).strip()
    # 길이 제한
    if len(text) > max_length:
        text = text[:max_length] + "..."

    return text


def build_github_section(activities: dict, commits: list[dict]) -> str:
    """GitHub 활동 섹션 생성 (링크, 시간, Reviews+Comments 그룹화)"""
    lines = ["\n## 🐙 GitHub 활동"]

    # Commits (git log 기반 + 이벤트 기반 병합)
    all_commits = commits + activities.get("commits", [])
    # 중복 제거 (sha 기준)
    seen_shas = set()
    unique_commits = []
    for c in all_commits:
        if c["sha"] not in seen_shas:
            seen_shas.add(c["sha"])
            unique_commits.append(c)

    # 저장소별로 그룹화
    repo_commits: dict[str, list[dict]] = {}
    for commit in unique_commits:
        repo = commit.get("repo", "unknown")
        if repo not in repo_commits:
            repo_commits[repo] = []
        repo_commits[repo].append(commit)

    if unique_commits:
        lines.append("\n### Commits")

        for repo, repo_commit_list in sorted(repo_commits.items()):
            # 저장소 헤더
            repo_url = repo_commit_list[0].get("repo_url", "") if repo_commit_list else ""
            repo_link = f"[{repo}]({repo_url})" if repo_url else f"**{repo}**"
            lines.append(f"\n#### {repo_link}")

            # PR별로 커밋 그룹화
            pr_groups: dict[Optional[int], list[dict]] = {}  # PR number -> commits
            pr_info_map: dict[int, dict] = {}  # PR number -> PR info

            for commit in repo_commit_list:
                pr = commit.get("pr")
                pr_number = pr.get("number") if pr else None

                if pr_number not in pr_groups:
                    pr_groups[pr_number] = []
                pr_groups[pr_number].append(commit)

                # PR 정보 저장
                if pr and pr_number and pr_number not in pr_info_map:
                    pr_info_map[pr_number] = pr

            # PR별로 출력 (PR 있는 것 먼저, 시간순)
            sorted_pr_numbers = sorted(
                pr_groups.keys(),
                key=lambda x: (
                    x is None,  # None(PR 없음)은 마지막에
                    min(c.get("time", "") for c in pr_groups[x])
                )
            )

            for pr_number in sorted_pr_numbers:
                pr_commits = pr_groups[pr_number]

                # PR 헤더 (있으면)
                if pr_number is not None:
                    pr = pr_info_map.get(pr_number, {})
                    pr_title = pr.get("title", "")
                    pr_url = pr.get("url", "")
                    pr_title_with_jira = linkify_jira_tickets(pr_title)
                    pr_link = f"[#{pr_number}]({pr_url})" if pr_url else f"#{pr_number}"
                    lines.append(f"\n**{pr_link}** {pr_title_with_jira}")

                # 같은 메시지의 커밋 병합 (메시지 기준으로 그룹화)
                message_groups: dict[str, list[dict]] = {}
                for commit in pr_commits:
                    msg = commit.get("message", "")
                    if msg not in message_groups:
                        message_groups[msg] = []
                    message_groups[msg].append(commit)

                # 시간순 정렬 (첫 번째 커밋 시간 기준)
                sorted_groups = sorted(
                    message_groups.items(),
                    key=lambda x: min(c.get("time", "") for c in x[1])
                )

                for msg, commits_with_same_msg in sorted_groups:
                    # 시간순 정렬
                    commits_with_same_msg.sort(key=lambda x: x.get("time", ""))
                    first_commit = commits_with_same_msg[0]
                    time_str = first_commit.get("time", "")
                    time_badge = f"`{time_str}` " if time_str else ""

                    # SHA 링크들 (중복 메시지가 여러 커밋에 있으면 모두 표시)
                    sha_links = []
                    for c in commits_with_same_msg:
                        sha = c.get("sha", "")
                        url = c.get("url", "")
                        sha_link = f"[{sha}]({url})" if url else f"`{sha}`"
                        sha_links.append(sha_link)

                    # 브랜치 정보 수집 (중복 제거)
                    all_branches = set()
                    for c in commits_with_same_msg:
                        for branch in c.get("branches", []):
                            all_branches.add(branch)

                    # 브랜치 표시 (있으면)
                    branch_info = ""
                    if all_branches:
                        branch_list = ", ".join(sorted(all_branches))
                        branch_info = f" `({branch_list})`"

                    # 여러 SHA가 있으면 같이 표시
                    sha_text = ", ".join(sha_links)
                    # Jira 티켓 번호를 링크로 변환
                    msg_with_jira = linkify_jira_tickets(msg)
                    lines.append(f"- {time_badge}{sha_text} {msg_with_jira}{branch_info}")

    # Pull Requests
    prs = activities.get("prs", [])
    if prs:
        # 시간순 정렬
        prs.sort(key=lambda x: x.get("time", ""))
        lines.append("\n### Pull Requests")
        for pr in prs:
            action_emoji = {"opened": "🆕", "closed": "✅", "merged": "🔀"}.get(
                pr["action"], "📝"
            )
            if pr.get("merged"):
                action_emoji = "🔀"
            time_str = pr.get("time", "")
            url = pr.get("url", "")
            repo_url = pr.get("repo_url", "")

            time_badge = f"`{time_str}` " if time_str else ""
            repo_link = f"[{pr['repo']}]({repo_url})" if repo_url else f"`{pr['repo']}`"
            pr_link = f"[#{pr['number']}]({url})" if url else f"#{pr['number']}"
            pr_title_with_jira = linkify_jira_tickets(pr['title'])
            lines.append(
                f"- {time_badge}{action_emoji} {repo_link} {pr_link} {pr_title_with_jira}"
            )

    # Reviews + Comments: PR별로 그룹화
    reviews = activities.get("reviews", [])
    comments = activities.get("comments", [])

    if reviews or comments:
        lines.append("\n### Reviews & Comments")

        # PR별로 그룹화
        pr_activities = {}  # key: (repo, pr_number), value: list of activities

        for review in reviews:
            key = (review.get("repo"), review.get("pr_number"))
            if key not in pr_activities:
                pr_activities[key] = {
                    "repo": review.get("repo"),
                    "pr_number": review.get("pr_number"),
                    "pr_title": review.get("pr_title", ""),
                    "url": review.get("url", ""),
                    "repo_url": review.get("repo_url", ""),
                    "items": [],
                    "first_time": review.get("time", "99:99"),
                }
            state_emoji = {
                "approved": "✅",
                "changes_requested": "🔄",
                "commented": "💬",
            }.get(review.get("state", "").lower(), "📝")
            pr_activities[key]["items"].append({
                "type": "review",
                "emoji": state_emoji,
                "body": review.get("body", ""),
                "time": review.get("time", ""),
                "item_url": review.get("review_url", ""),  # 리뷰 직접 링크
            })
            # 가장 빠른 시간 업데이트
            if review.get("time", "99:99") < pr_activities[key]["first_time"]:
                pr_activities[key]["first_time"] = review.get("time", "99:99")

        for comment in comments:
            pr_number = comment.get("pr_number")
            issue_number = comment.get("issue_number")
            number = pr_number or issue_number
            key = (comment.get("repo"), number)

            if key not in pr_activities:
                pr_activities[key] = {
                    "repo": comment.get("repo"),
                    "pr_number": number,
                    "pr_title": comment.get("pr_title") or comment.get("issue_title", ""),
                    "url": comment.get("url", ""),
                    "repo_url": comment.get("repo_url", ""),
                    "items": [],
                    "first_time": comment.get("time", "99:99"),
                    "is_issue": comment.get("type") == "issue_comment",
                }
            pr_activities[key]["items"].append({
                "type": "comment",
                "emoji": "💬",
                "body": comment.get("body", ""),
                "time": comment.get("time", ""),
                "item_url": comment.get("comment_url", ""),  # 코멘트 직접 링크
            })
            if comment.get("time", "99:99") < pr_activities[key]["first_time"]:
                pr_activities[key]["first_time"] = comment.get("time", "99:99")

        # PR별로 시간순 정렬 후 출력
        sorted_prs = sorted(pr_activities.values(), key=lambda x: x.get("first_time", ""))

        for pr_data in sorted_prs:
            repo = pr_data.get("repo", "")
            pr_number = pr_data.get("pr_number", "")
            pr_title = pr_data.get("pr_title", "")
            url = pr_data.get("url", "")
            repo_url = pr_data.get("repo_url", "")
            items = pr_data.get("items", [])
            is_issue = pr_data.get("is_issue", False)

            repo_link = f"[{repo}]({repo_url})" if repo_url else f"`{repo}`"
            number_link = f"[#{pr_number}]({url})" if url else f"#{pr_number}"

            # PR/Issue 헤더 (Jira 티켓 링크 적용)
            pr_title_with_jira = linkify_jira_tickets(pr_title)
            lines.append(f"- {repo_link} {number_link} {pr_title_with_jira}")

            # 아이템들 (시간순 정렬)
            items.sort(key=lambda x: x.get("time", ""))
            for item in items:
                time_str = item.get("time", "")
                time_badge = f"`{time_str}` " if time_str else ""
                emoji = item.get("emoji", "💬")
                body = clean_markdown_body(item.get("body", ""))
                item_url = item.get("item_url", "")

                # 링크가 있으면 이모지를 링크로 감싸기
                if item_url:
                    emoji_link = f"[{emoji}]({item_url})"
                else:
                    emoji_link = emoji

                if body:
                    lines.append(f"  - {time_badge}{emoji_link} {body}")
                else:
                    lines.append(f"  - {time_badge}{emoji_link} (코멘트)")

    if len(lines) == 1:
        lines.append("\n_활동 내역이 없습니다._")

    lines.append("")
    return "\n".join(lines)


def get_daily_note_path(target_date: str) -> Path:
    """Daily Note 경로"""
    vault_path = Path(CONFIG["vault"]["path"])
    daily_folder = CONFIG["vault"].get("daily_folder", "DAILY")
    return vault_path / daily_folder / f"{target_date}.md"


def update_daily_note(target_date: str, github_section: str) -> str:
    """Daily Note에 GitHub 섹션 추가"""
    daily_path = get_daily_note_path(target_date)

    if not daily_path.exists():
        print(f"⚠️  {target_date} Daily Note가 없습니다.")
        print("   먼저 daily.py --init 을 실행하세요.")
        return ""

    with open(daily_path, "r", encoding="utf-8") as f:
        content = f.read()

    # 기존 GitHub 섹션이 있으면 교체
    if "## 🐙 GitHub 활동" in content:
        pattern = r"## 🐙 GitHub 활동.*?(?=\n## |\Z)"
        content = re.sub(pattern, github_section.strip(), content, flags=re.DOTALL)
    else:
        # "## ✅ 오늘 한 일" 섹션 앞에 추가
        if "## ✅ 오늘 한 일" in content:
            content = content.replace(
                "## ✅ 오늘 한 일", f"{github_section}\n## ✅ 오늘 한 일"
            )
        else:
            content = content.rstrip() + "\n" + github_section

    with open(daily_path, "w", encoding="utf-8") as f:
        f.write(content)

    return str(daily_path)


def main():
    # 옵션 파싱
    yes_mode = "--yes" in sys.argv or "-y" in sys.argv
    args = [a for a in sys.argv[1:] if a not in ("--yes", "-y")]

    target_date = None
    override_repos = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--today":
            target_date = datetime.now().strftime("%Y-%m-%d")
            i += 1
        elif arg == "--repos" and i + 1 < len(args):
            override_repos = [r.strip() for r in args[i + 1].split(",") if r.strip()]
            i += 2
        elif not arg.startswith("-"):
            target_date = arg
            i += 1
        else:
            i += 1

    # 기본값: 어제
    if not target_date:
        target_date = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"🐙 GitHub Sync: {target_date}")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    # GitHub 사용자명 조회
    username = get_username()
    print(f"   User: {username}")

    # 이벤트 수집
    print("\n📡 활동 수집 중...")
    events = get_user_events(username, target_date)
    activities = parse_events(events)

    # 로컬 git 커밋도 수집
    commits = get_commits_from_repos(username, target_date, override_repos=override_repos)

    # 통계 출력
    total_commits = len(commits) + len(activities.get("commits", []))
    print(f"   📝 Commits: {total_commits}")
    print(f"   🔍 Reviews: {len(activities.get('reviews', []))}")
    print(f"   💬 Comments: {len(activities.get('comments', []))}")
    print(f"   📋 PRs: {len(activities.get('prs', []))}")

    if not any(
        [
            commits,
            activities.get("commits"),
            activities.get("reviews"),
            activities.get("comments"),
            activities.get("prs"),
        ]
    ):
        print(f"\n📭 {target_date}에 GitHub 활동이 없습니다.")
        return

    # GitHub 섹션 생성
    github_section = build_github_section(activities, commits)

    # 미리보기
    print("\n" + "━" * 40)
    print("📋 미리보기")
    print("━" * 40)
    print(github_section)
    print("━" * 40)

    # Daily Note 업데이트
    if yes_mode:
        choice = "y"
    else:
        try:
            choice = input("\nDaily Note에 추가할까요? [Y/n]: ").strip().lower()
        except EOFError:
            choice = "y"

    if choice in ["", "y", "yes"]:
        result_path = update_daily_note(target_date, github_section)
        if result_path:
            print(f"\n✅ Daily Note 업데이트 완료!")
            print(f"   {result_path}")
    else:
        print("\n⏭️  건너뛰었습니다.")


if __name__ == "__main__":
    main()
