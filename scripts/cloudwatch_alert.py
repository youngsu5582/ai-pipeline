#!/usr/bin/env python3
"""
AI Pipeline - CloudWatch Error Alert
=====================================
AWS CloudWatch 로그에서 에러를 감지하여 Slack으로 알림

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
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta
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


def get_monitor_config() -> dict:
    """모니터링 설정 조회"""
    return CONFIG.get("monitor", {})


def get_cloudwatch_config(
    override_log_groups: list[str] = None,
    override_patterns: list[str] = None
) -> dict:
    """CloudWatch 설정 조회

    Args:
        override_log_groups: 옵션으로 전달된 로그 그룹 목록
        override_patterns: 옵션으로 전달된 에러 패턴 목록
    """
    monitor = get_monitor_config()
    cw_config = monitor.get("cloudwatch", {})

    # 옵션으로 로그 그룹이 전달된 경우
    if override_log_groups:
        cw_config["log_groups"] = override_log_groups

    # 옵션으로 에러 패턴이 전달된 경우
    if override_patterns:
        cw_config["error_patterns"] = override_patterns

    if not cw_config.get("log_groups"):
        print("⚠️  CloudWatch 로그 그룹이 설정되지 않았습니다.")
        print("   config/settings.yaml에 monitor.cloudwatch.log_groups를 설정하거나")
        print("   --log-groups 옵션으로 지정하세요.")
        print("")
        print("   예시:")
        print("   monitor:")
        print("     cloudwatch:")
        print("       log_groups:")
        print('         - "/aws/lambda/my-function"')
        print("")
        print("   또는: python cloudwatch_alert.py --log-groups \"/aws/lambda/func1,/aws/ecs/svc1\"")
        sys.exit(1)

    return cw_config


def create_cloudwatch_client(profile: Optional[str] = None, region: str = "ap-northeast-2"):
    """CloudWatch Logs 클라이언트 생성"""
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


def query_logs(
    client,
    log_groups: list[str],
    error_patterns: list[str],
    hours: int = 1
) -> list[dict]:
    """CloudWatch Logs Insights로 에러 로그 쿼리"""
    results = []

    end_time = datetime.now()
    start_time = end_time - timedelta(hours=hours)

    # 에러 패턴을 OR로 연결
    pattern_filter = " or ".join([f'@message like /{p}/' for p in error_patterns])

    query = f"""
    fields @timestamp, @message, @logStream
    | filter {pattern_filter}
    | sort @timestamp desc
    | limit 50
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

            # 쿼리 완료 대기
            import time
            while True:
                result = client.get_query_results(queryId=query_id)
                status = result["status"]

                if status == "Complete":
                    break
                elif status in ["Failed", "Cancelled"]:
                    print(f"   ⚠️  쿼리 실패: {log_group}")
                    break

                time.sleep(0.5)

            # 결과 파싱
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


def build_summary(errors: list[dict], hours: int) -> dict:
    """에러 요약 생성"""
    if not errors:
        return {
            "total": 0,
            "by_group": {},
            "samples": [],
        }

    # 로그 그룹별 집계
    by_group = {}
    for error in errors:
        group = error.get("log_group", "unknown")
        if group not in by_group:
            by_group[group] = 0
        by_group[group] += 1

    # 샘플 (최근 5개)
    samples = []
    for error in errors[:5]:
        message = error.get("@message", "")
        # 메시지 정리 (너무 길면 자르기)
        if len(message) > 200:
            message = message[:200] + "..."
        samples.append({
            "timestamp": error.get("@timestamp", ""),
            "log_group": error.get("log_group", ""),
            "message": message,
        })

    return {
        "total": len(errors),
        "by_group": by_group,
        "samples": samples,
        "hours": hours,
    }


def send_slack_notification(summary: dict, region: str = "ap-northeast-2") -> bool:
    """Slack으로 알림 전송"""
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")

    if not webhook_url:
        print("⚠️  SLACK_WEBHOOK_URL 환경변수가 설정되지 않았습니다.")
        return False

    if summary["total"] == 0:
        # 에러가 없으면 알림 안 보냄
        return True

    # 블록 구성
    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": f"🚨 CloudWatch 에러 감지 ({summary['total']}건)",
                "emoji": True
            }
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"최근 *{summary.get('hours', 1)}시간* 동안 감지된 에러"
            }
        },
        {"type": "divider"},
    ]

    # 로그 그룹별 통계
    group_text = "\n".join([
        f"• `{group}`: {count}건"
        for group, count in summary["by_group"].items()
    ])
    blocks.append({
        "type": "section",
        "text": {
            "type": "mrkdwn",
            "text": f"*로그 그룹별 통계*\n{group_text}"
        }
    })

    # 샘플 에러
    if summary["samples"]:
        blocks.append({"type": "divider"})
        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "*최근 에러 샘플*"
            }
        })

        for sample in summary["samples"][:3]:
            timestamp = sample.get("timestamp", "")[:19]  # ISO format 자르기
            message = sample.get("message", "")
            # 코드 블록으로 표시
            blocks.append({
                "type": "context",
                "elements": [
                    {
                        "type": "mrkdwn",
                        "text": f"_{timestamp}_\n```{message}```"
                    }
                ]
            })

    # CloudWatch 링크
    first_group = list(summary["by_group"].keys())[0] if summary["by_group"] else ""
    if first_group:
        console_url = (
            f"https://{region}.console.aws.amazon.com/cloudwatch/home"
            f"?region={region}#logsV2:log-groups/log-group/{first_group.replace('/', '$252F')}"
        )
        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"<{console_url}|CloudWatch 콘솔에서 확인하기>"
            }
        })

    payload = {"blocks": blocks}

    try:
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            webhook_url,
            data=data,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status == 200
    except Exception as e:
        print(f"⚠️  Slack 알림 전송 실패: {e}")
        return False


def print_summary(summary: dict):
    """콘솔에 요약 출력"""
    print("\n" + "━" * 40)
    print("📊 에러 요약")
    print("━" * 40)

    if summary["total"] == 0:
        print("✅ 에러가 감지되지 않았습니다.")
        return

    print(f"총 에러: {summary['total']}건")
    print("")
    print("로그 그룹별:")
    for group, count in summary["by_group"].items():
        print(f"  • {group}: {count}건")

    if summary["samples"]:
        print("")
        print("최근 에러 샘플:")
        for sample in summary["samples"][:3]:
            timestamp = sample.get("timestamp", "")[:19]
            message = sample.get("message", "")[:100]
            print(f"  [{timestamp}] {message}")

    print("━" * 40)


def main():
    # 옵션 파싱
    args = sys.argv[1:]

    hours = 1
    profile = None
    region = "ap-northeast-2"
    slack_mode = False
    yes_mode = False
    log_groups_override = None  # --log-groups 옵션
    patterns_override = None     # --patterns 옵션

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
            yes_mode = True
            i += 1
        else:
            i += 1

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"🔍 CloudWatch Error Alert")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"   조회 범위: 최근 {hours}시간")
    print(f"   리전: {region}")
    if profile:
        print(f"   AWS Profile: {profile}")
    if log_groups_override:
        print(f"   소스: 옵션 지정 ({len(log_groups_override)}개 로그 그룹)")

    # 설정 로드
    cw_config = get_cloudwatch_config(
        override_log_groups=log_groups_override,
        override_patterns=patterns_override
    )
    log_groups = cw_config.get("log_groups", [])
    error_patterns = cw_config.get("error_patterns", ["ERROR", "Exception", "FATAL"])

    print(f"   로그 그룹: {len(log_groups)}개")
    print(f"   에러 패턴: {', '.join(error_patterns)}")
    print("")

    # CloudWatch 클라이언트 생성
    client = create_cloudwatch_client(profile, region)

    # 로그 쿼리
    print("📡 에러 로그 조회 중...")
    errors = query_logs(client, log_groups, error_patterns, hours)

    # 요약 생성
    summary = build_summary(errors, hours)

    # 콘솔 출력
    print_summary(summary)

    # Slack 알림
    if slack_mode and summary["total"] > 0:
        print("\n📤 Slack 알림 전송 중...")
        if send_slack_notification(summary, region=region):
            print("✅ Slack 알림 전송 완료!")
        else:
            print("❌ Slack 알림 전송 실패")
    elif slack_mode and summary["total"] == 0:
        print("\n✅ 에러 없음 - Slack 알림 생략")


if __name__ == "__main__":
    main()
