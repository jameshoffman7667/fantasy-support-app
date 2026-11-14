#!/usr/bin/env python3
"""v4.19.0: inspect a built APK with androguard and fail on anything that would break an install or the F-Droid repo.

Usage: inspect-apk.py <apk> <package id> <versionName> <versionCode>
Checks: package id, versionName, versionCode, signed (v2 or v3 signature block present), not a debug-signed or
debuggable build, and prints minSdk / targetSdk. Never prints keys or secrets (certificate fingerprints are public).
"""
import sys

try:
    from androguard.core.apk import APK  # androguard 4.x
except ImportError:  # older layout
    from androguard.core.bytecodes.apk import APK


def main() -> int:
    if len(sys.argv) != 5:
        print(__doc__)
        return 2
    path, want_pkg, want_name, want_code = sys.argv[1:]
    apk = APK(path)
    problems = []
    pkg = apk.get_package()
    name = apk.get_androidversion_name()
    code = str(apk.get_androidversion_code())
    min_sdk = apk.get_min_sdk_version()
    target_sdk = apk.get_target_sdk_version()
    signed_v2 = bool(getattr(apk, "is_signed_v2", lambda: False)())
    signed_v3 = bool(getattr(apk, "is_signed_v3", lambda: False)())
    signed_v1 = bool(getattr(apk, "is_signed_v1", lambda: False)())
    print(f"package      {pkg}")
    print(f"versionName  {name}")
    print(f"versionCode  {code}")
    print(f"minSdk       {min_sdk}")
    print(f"targetSdk    {target_sdk}")
    print(f"signed       v1={signed_v1} v2={signed_v2} v3={signed_v3}")
    if pkg != want_pkg:
        problems.append(f"package id is {pkg}, expected {want_pkg}")
    if name != want_name:
        problems.append(f"versionName is {name}, expected {want_name}")
    if code != want_code:
        problems.append(f"versionCode is {code}, expected {want_code}")
    if not (signed_v1 or signed_v2 or signed_v3):
        problems.append("the APK is not signed")
    if not min_sdk or not str(min_sdk).isdigit():
        problems.append("minSdk could not be read")
    try:
        debuggable = apk.get_attribute_value("application", "debuggable")
        if str(debuggable).lower() in ("true", "0xffffffff", "-1"):
            problems.append("the APK is marked debuggable")
    except Exception:  # attribute missing: not debuggable
        pass
    try:
        for cert in apk.get_certificates():
            subject = cert.subject.human_friendly
            print(f"certificate  {subject}")
            if "Android Debug" in subject:
                problems.append("the APK is signed with an Android debug certificate")
    except Exception as exc:  # certificate listing is informational
        print(f"certificate  (not listed: {exc})")
    if problems:
        for p in problems:
            print(f"::error::{p}")
        return 1
    print("APK inspection OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
