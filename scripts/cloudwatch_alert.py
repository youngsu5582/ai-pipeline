#!/usr/bin/env python3
"""
AI Pipeline - CloudWatch Error Alert
=====================================
AWS CloudWatch 로그에서 에러를 감지, 패턴별 그룹핑/노이즈 필터링/신규 감지 후 알림

Usage:
    python cloudwatch_alert.py                           # 설정 파일 기준
    python cloudwatch_alert.py --hours 2                 # 최근 2시간
    python cloudwatch_alert.py --profile prod            # 특정 AWS 프로필
    python cloudwatch_alert.py --region us-east-1        # AWS 리전 지정
    python cloudwatch_alert.py --log-groups "grp1,grp2"  # 로그 그룹 지정
    python cloudwatch_alert.py --patterns "ERROR,FATAL"  # 에러 패턴 지정
    python cloudwatch_alert.py --slack                   # Slack 알림 전송

Options:
    --hours N              최근 N시간 로그 조회 (기본: 1)
    --profile NAME         AWS 프로필 이름
    --region REGION        AWS 리전 (기본: ap-northeast-2)
    --log-groups GRP,...   쉼표로 구분된 로그 그룹 목록
    --patterns PAT,...     쉼표로 구분된 에러 패턴 목록
    --slack                Slack 알림 전송

Requirements:
    - boto3 설치 (pip install boto3)
    - AWS credentials 설정 (aws configure 또는 환경변수)
    - config/settings.yaml에 monitor.cloudwatch 설정 (옵션 미지정 시)
"""

import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import yaml

try:
    import boto3
    from botocore.exceptions import ClientError, ProfileNotFound
except ImportError:
    print("❌ boto3가 설치되어 있지 않습니다.")
    print("   pip install boto3")
    sys.exit(1)


CONFIG_PATH = Path(__file__).parent.parent / "config" / "settings.yaml"
HISTORY_FILE = Path(__file__).parent.parent / "dashboard" / "data" / "cloudwatch-error-history.json"

# 빌트인 노이즈 패턴 (네트워크/외부API/클라이언트 에러)
BUILTIN_NOISE_PATTERNS = [
    # Network / External API
    r"SocketTimeoutException",
    r"ConnectTimeoutException",
    r"HttpHostConnectException",
    r"ConnectionRefused",
    r"UnknownHostException",
    r"NoRouteToHostException",
    r"SSLHandshakeException",
    r"SocketException",
    # Client disconnection
    r"ClientAbortException",
    r"Broken pipe",
    r"Connection reset by peer",
    r"EOFException",
    # Rate limiting / throttling
    r"TooManyRequestsException",
    r"ThrottlingException",
    r"RateLimitException",
]


# ─── Config ─────────────────────────────────────────────

def load_config() -> dict:
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


def get_cloudwatch_config(
    override_log_groups: list[str] = None,
    override_patterns: list[str] = None,
) -> dict:
    monitor = CONFIG.get("monitor", {})
    cw_config = monitor.get("cloudwatch", {})

    if override_log_groups:
        cw_config["log_groups"] = override_log_groups
    if override_patterns:
        cw_config["error_patterns"] = override_patterns

    if not cw_config.get("log_groups"):
        print("⚠️  CloudWatch 로그 그룹이 설정되지 않았습니다.")
        print("   --log-groups 옵션으로 지정하거나 config/settings.yaml에 설정하세요.")
        sys.exit(1)

    return cw_config


# ─── AWS Client ─────────────────────────────────────────

def create_cloudwatch_client(profile: Optional[str] = None, region: str = "ap-northeast-2"):
    try:
        if profile:
            session = boto3.Session(profile_name=profile, region_name=region)
            return session.client("logs")
        return boto3.client("logs", region_name=region)
    except ProfileNotFound:
        print(f"❌ AWS 프로필 '{profile}'을 찾을 수 없습니다.")
        sys.exit(1)
    except Exception as e:
        print(f"❌ AWS 클라이언트 생성 실패: {e}")
        sys.exit(1)


# ─── Log Query ──────────────────────────────────────────

def query_logs(
    client,
    log_groups: list[str],
    error_patterns: list[str],
    hours: int = 1,
) -> list[dict]:
    results = []
    end_time = datetime.now()
    start_time = end_time - timedelta(hours=hours)

    pattern_filter = " or ".join([f"@message like /{p}/" for p in error_patterns])
    query = f"""
    fields @timestamp, @message, @logStream
    | filter {pattern_filter}
    | sort @timestamp desc
    | limit 100
    """

    for log_group in log_groups:
        try:
            print(f"   📡 조회 중: {log_group}")
            response = client.start_query(
                logGroupName=log_group,
                startTime=int(start_time.timestamp() * 1000),
                endTime=int(end_time.timestamp() * 1000),
                queryString=query,
            )
            query_id = response["queryId"]

            import time
            while True:
                result = client.get_query_results(queryId=query_id)
                status = result["status"]
                if status == "Complete":
                    break
                elif status in ("Failed", "Cancelled"):
                    print(f"   ⚠️  쿼리 실패: {log_group}")
                    break
                time.sleep(0.5)

            for record in result.get("results", []):
                log_entry = {}
                for field in record:
                    log_entry[field["field"]] = field["value"]
                log_entry["log_group"] = log_group
                results.append(log_entry)

        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code", "")
            if error_code == "ResourceNotFoundException":
                print(f"   ⚠️  로그 그룹 없음: {log_group}")
            else:
                print(f"   ⚠️  쿼리 오류 ({log_group}): {e}")
        except Exception as e:
            print(f"   ⚠️  예외 발생 ({log_group}): {e}")

    return results


# ─── Error Pattern Extraction ───────────────────────────

def extract_error_key(message: str) -> Optional[str]:
    """에러 메시지에서 그룹핑 키 추출"""
    if not message:
        return None

    line = message.strip()

    # Stack trace line → skip
    if line.startswith("at ") or line.startswith("Caused by:") or line.startswith("..."):
        return None

    # Java Exception: "com.example.SomeException: message"
    exc_match = re.search(
        r"([\w$.]+(?:Exception|Error|Failure|Fault|Throwable))\s*:\s*(.*)", line
    )
    if exc_match:
        exc_class = exc_match.group(1).split(".")[-1]
        exc_msg = exc_match.group(2).strip()
        # 가변 부분 정규화
        exc_msg = re.sub(r"\b[0-9a-f]{8,}\b", "{id}", exc_msg)
        exc_msg = re.sub(r"\b\d{5,}\b", "{num}", exc_msg)
        exc_msg = re.sub(r"https?://\S+", "{url}", exc_msg)
        # key=value / key: value 패턴의 value 정규화
        exc_msg = re.sub(r"(preset|langCode|consumer|name|desc|image_file|prompt)[=:]\s*\S+", r"\1={val}", exc_msg)
        # JSON/배열 내용 축약
        exc_msg = re.sub(r"\{[^}]{20,}\}", "{...}", exc_msg)
        exc_msg = re.sub(r"\[[^\]]{30,}\]", "[...]", exc_msg)
        exc_msg = exc_msg[:80]
        return f"{exc_class}: {exc_msg}" if exc_msg else exc_class

    # Java Exception class only: "com.example.SomeException"
    exc_only = re.search(
        r"([\w$.]+(?:Exception|Error|Failure|Fault|Throwable))\s*$", line
    )
    if exc_only:
        return exc_only.group(1).split(".")[-1]

    # Spring log format: "HH:mm:ss.SSS [...] [LEVEL] [class] message"
    spring_match = re.search(
        r"\[(\w+)\s*\]\s+\[[\w$.]+\]\s+(.*)", line
    )
    if spring_match:
        level = spring_match.group(1).strip()
        msg = spring_match.group(2).strip()
        if level in ("ERROR", "WARN", "FATAL"):
            msg = re.sub(r"\b[0-9a-f]{8,}\b", "{id}", msg)
            msg = re.sub(r"https?://\S+", "{url}", msg)
            msg = re.sub(r"(consumer|name|desc|image_file)[=:]\s*\S+", r"\1={val}", msg)
            msg = re.sub(r"\{[^}]{20,}\}", "{...}", msg)
            msg = re.sub(r"\[[^\]]{30,}\]", "[...]", msg)
            msg = msg[:80]
            return f"[{level}] {msg}"

    # Fallback: 첫 100자 정규화
    key = line[:100]
    key = re.sub(r"\b[0-9a-f]{8,}\b", "{id}", key)
    key = re.sub(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[\d.]*", "{ts}", key)
    key = re.sub(r"\b\d{5,}\b", "{num}", key)
    return key


# ─── Error Grouping ─────────────────────────────────────

def group_errors(errors: list[dict]) -> dict:
    """에러를 패턴별로 그룹핑"""
    groups = {}

    for error in errors:
        message = error.get("@message", "")
        key = extract_error_key(message)
        if not key:
            continue

        if key not in groups:
            groups[key] = {
                "key": key,
                "count": 0,
                "log_groups": set(),
                "last_seen": "",
                "sample": "",
            }

        groups[key]["count"] += 1
        groups[key]["log_groups"].add(error.get("log_group", ""))

        ts = error.get("@timestamp", "")
        if ts > groups[key]["last_seen"]:
            groups[key]["last_seen"] = ts

        if not groups[key]["sample"]:
            groups[key]["sample"] = message[:200]

    return groups


# ─── Noise Classification ───────────────────────────────

def classify_groups(
    groups: dict,
    custom_ignore: list[str] = None,
) -> tuple[list[dict], list[dict]]:
    """에러 그룹을 attention / noise로 분류

    Returns: (attention_list, noise_list)
    """
    all_patterns = BUILTIN_NOISE_PATTERNS + (custom_ignore or [])
    attention = []
    noise = []

    for key, group in groups.items():
        is_noise = False
        for pattern in all_patterns:
            if re.search(pattern, key, re.IGNORECASE):
                is_noise = True
                break

        entry = {
            **group,
            "log_groups": list(group["log_groups"]),
        }

        if is_noise:
            noise.append(entry)
        else:
            attention.append(entry)

    # attention: 건수 많은 순, noise: 건수 많은 순
    attention.sort(key=lambda x: x["count"], reverse=True)
    noise.sort(key=lambda x: x["count"], reverse=True)

    return attention, noise


# ─── Error History ───────────────────────────────────────

def _today_str() -> str:
    kst = timezone(timedelta(hours=9))
    return datetime.now(kst).strftime("%Y-%m-%d")


def load_error_history() -> dict:
    if HISTORY_FILE.exists():
        try:
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_error_history(history: dict):
    HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)


def update_history(attention: list[dict], noise: list[dict]) -> set[str]:
    """히스토리 업데이트 후 신규 패턴 키 set 반환"""
    history = load_error_history()
    today = _today_str()
    new_keys = set()

    for group in attention + noise:
        key = group["key"]
        if key not in history:
            history[key] = {"first_seen": today, "last_seen": today, "total_count": 0}
            new_keys.add(key)
        history[key]["last_seen"] = today
        history[key]["total_count"] = history[key].get("total_count", 0) + group["count"]

    # 30일 이상 안 나타난 패턴 정리
    cutoff = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
    expired = [k for k, v in history.items() if v.get("last_seen", "") < cutoff]
    for k in expired:
        del history[k]

    save_error_history(history)
    return new_keys


# ─── Console Output ─────────────────────────────────────

def _short_group(log_group: str) -> str:
    """로그 그룹명 축약: /ecs/my-app/production/web → web"""
    return log_group.rstrip("/").split("/")[-1]


def print_analysis(
    attention: list[dict],
    noise: list[dict],
    new_keys: set[str],
    total_errors: int,
    hours: int,
):
    total_patterns = len(attention) + len(noise)
    noise_count = sum(g["count"] for g in noise)

    print("\n" + "━" * 50)
    print("📊 에러 분석 결과")
    print("━" * 50)
    print(
        f"최근 {hours}시간 | 총 {total_errors}건 → "
        f"{total_patterns}종 패턴 ({len(attention)}종 주의, {len(noise)}종 무시)"
    )

    if attention:
        print(f"\n🔴 주의 필요 ({len(attention)}종)")
        for g in attention:
            new_mark = "🆕 " if g["key"] in new_keys else ""
            groups_str = ", ".join(_short_group(lg) for lg in g["log_groups"])
            last_time = g["last_seen"][11:16] if len(g["last_seen"]) > 11 else ""
            print(f"  {new_mark}{g['key']} ({g['count']}건)")
            print(f"     {groups_str} | 최근: {last_time}")
            print()
    else:
        print("\n✅ 주의가 필요한 에러 없음")

    if noise:
        noise_summary = ", ".join(
            f"{g['key'].split(':')[0]}({g['count']})" for g in noise[:5]
        )
        remaining = len(noise) - 5
        if remaining > 0:
            noise_summary += f", ...+{remaining}종"
        print(f"⚪ 무시됨 ({len(noise)}종, {noise_count}건)")
        print(f"  {noise_summary}")

    print("━" * 50)


# ─── Slack Notification ─────────────────────────────────

def send_slack_notification(
    attention: list[dict],
    noise: list[dict],
    new_keys: set[str],
    total_errors: int,
    hours: int,
    region: str = "ap-northeast-2",
) -> bool:
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")
    if not webhook_url:
        print("⚠️  SLACK_WEBHOOK_URL 환경변수가 설정되지 않았습니다.")
        return False

    if not attention and not noise:
        return True

    noise_count = sum(g["count"] for g in noise)

    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": f"🚨 CloudWatch 에러 ({len(attention)}종 주의 필요)"
                if attention
                else f"✅ CloudWatch ({total_errors}건, 모두 무시 가능)",
                "emoji": True,
            },
        },
    ]

    # 주의 필요 목록
    if attention:
        lines = []
        for g in attention[:10]:
            new_mark = ":new: " if g["key"] in new_keys else ""
            groups_str = ", ".join(_short_group(lg) for lg in g["log_groups"])
            key_display = g["key"][:60] + "..." if len(g["key"]) > 60 else g["key"]
            lines.append(f"{new_mark}*{key_display}* - {g['count']}건 (`{groups_str}`)")

        if len(attention) > 10:
            lines.append(f"_...외 {len(attention) - 10}종_")

        blocks.append(
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f":red_circle: *주의 필요* ({len(attention)}종)\n"
                    + "\n".join(lines),
                },
            }
        )

    # 무시됨 요약
    if noise:
        short = ", ".join(g["key"].split(":")[0] for g in noise[:4])
        remaining = len(noise) - 4
        if remaining > 0:
            short += f", +{remaining}종"
        blocks.append(
            {
                "type": "context",
                "elements": [
                    {
                        "type": "mrkdwn",
                        "text": f"⚪ 무시: {len(noise)}종 {noise_count}건 ({short})",
                    }
                ],
            }
        )

    # CloudWatch 콘솔 링크
    all_groups = set()
    for g in attention + noise:
        all_groups.update(g["log_groups"])
    first_group = sorted(all_groups)[0] if all_groups else ""
    if first_group:
        console_url = (
            f"https://{region}.console.aws.amazon.com/cloudwatch/home"
            f"?region={region}#logsV2:log-groups/log-group/"
            f"{first_group.replace('/', '$252F')}"
        )
        blocks.append(
            {
                "type": "context",
                "elements": [
                    {
                        "type": "mrkdwn",
                        "text": f"<{console_url}|CloudWatch 콘솔에서 확인>",
                    }
                ],
            }
        )

    payload = {"blocks": blocks}

    try:
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            webhook_url,
            data=data,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status == 200
    except Exception as e:
        print(f"⚠️  Slack 알림 전송 실패: {e}")
        return False


# ─── Main ───────────────────────────────────────────────

def main():
    args = sys.argv[1:]

    hours = 1
    profile = None
    region = "ap-northeast-2"
    slack_mode = False
    log_groups_override = None
    patterns_override = None

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--hours" and i + 1 < len(args):
            hours = int(args[i + 1])
            i += 2
        elif arg == "--profile" and i + 1 < len(args):
            profile = args[i + 1]
            i += 2
        elif arg == "--region" and i + 1 < len(args):
            region = args[i + 1]
            i += 2
        elif arg == "--log-groups" and i + 1 < len(args):
            log_groups_override = [g.strip() for g in args[i + 1].split(",") if g.strip()]
            i += 2
        elif arg == "--patterns" and i + 1 < len(args):
            patterns_override = [p.strip() for p in args[i + 1].split(",") if p.strip()]
            i += 2
        elif arg == "--slack":
            slack_mode = True
            i += 1
        elif arg in ("--yes", "-y"):
            i += 1
        else:
            i += 1

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("🔍 CloudWatch Error Alert")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"   조회 범위: 최근 {hours}시간")
    print(f"   리전: {region}")
    if profile:
        print(f"   AWS Profile: {profile}")

    # 설정 로드
    cw_config = get_cloudwatch_config(
        override_log_groups=log_groups_override,
        override_patterns=patterns_override,
    )
    log_groups = cw_config.get("log_groups", [])
    error_patterns = cw_config.get("error_patterns", ["ERROR", "Exception", "FATAL"])
    custom_ignore = cw_config.get("ignore_patterns", [])

    print(f"   로그 그룹: {len(log_groups)}개")
    print(f"   에러 패턴: {', '.join(error_patterns)}")
    if custom_ignore:
        print(f"   무시 패턴: {len(custom_ignore)}개 (사용자 설정)")
    print("")

    # CloudWatch 클라이언트 생성 + 로그 쿼리
    client = create_cloudwatch_client(profile, region)

    print("📡 에러 로그 조회 중...")
    errors = query_logs(client, log_groups, error_patterns, hours)
    total_errors = len(errors)

    # 분석: 그룹핑 → 분류 → 히스토리
    groups = group_errors(errors)
    attention, noise = classify_groups(groups, custom_ignore)
    new_keys = update_history(attention, noise)

    # 콘솔 출력
    print_analysis(attention, noise, new_keys, total_errors, hours)

    # Slack 알림 (주의 필요 에러가 있을 때만)
    if slack_mode:
        if attention:
            print("\n📤 Slack 알림 전송 중...")
            if send_slack_notification(
                attention, noise, new_keys, total_errors, hours, region
            ):
                print("✅ Slack 알림 전송 완료!")
            else:
                print("❌ Slack 알림 전송 실패")
        else:
            print(f"\n✅ 주의 필요 에러 없음 ({total_errors}건 모두 무시 가능) - Slack 생략")


if __name__ == "__main__":
    main()
