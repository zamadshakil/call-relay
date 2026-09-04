#!/bin/bash
set -euo pipefail

# Run on the Mac: bash apply-audio-fix.sh /Users/hh/Documents/CallRelay
# This is an update to an existing working project, not a project generator.
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
target_dir="$(cd "${1:?Pass the folder containing CallRelay.xcodeproj}" && pwd -P)"
if [[ "$source_dir" == "$target_dir" ]]; then
    printf 'Run this installer from the extracted update folder, not inside the target project. Nothing changed.\n' >&2
    exit 1
fi
if [[ ! -d "$target_dir/CallRelay.xcodeproj" ]]; then
    printf 'No CallRelay.xcodeproj in %s. Nothing changed.\n' "$target_dir" >&2
    exit 1
fi
files=(
    CallRelay/Call/CallCoordinator.swift
    CallRelay/Call/CallKitController.swift
    CallRelay/Media/AudioSessionController.swift
    CallRelay/Media/MediaAdapter.swift
    CallRelay/Media/WebRTCMediaAdapter.swift
    CallRelay/UI/ActiveCallView.swift
    CallRelayTests/ProtocolPolicyTests.swift
)
for relative in "${files[@]}"; do
    if [[ ! -f "$source_dir/$relative" || ! -f "$target_dir/$relative" ]]; then
        printf 'Missing source or destination: %s. Nothing changed.\n' "$relative" >&2
        exit 1
    fi
    # Refuse symlinked source/destination directories or files before copying.
    for root in "$source_dir" "$target_dir"; do
        candidate="$root/$relative"
        while [[ "$candidate" != "$root" ]]; do
            if [[ -L "$candidate" ]]; then
                printf 'Symlinked path: %s. Nothing changed.\n' "$candidate" >&2
                exit 1
            fi
            candidate="$(dirname "$candidate")"
        done
    done
done
backup_dir="$(mktemp -d "$target_dir/.callrelay-audio-backup.XXXXXX")"
# Complete the backup before changing any target file.
for relative in "${files[@]}"; do
    mkdir -p "$backup_dir/$(dirname "$relative")"
    cp -p "$target_dir/$relative" "$backup_dir/$relative"
done
printf 'Original files backed up in: %s\n' "$backup_dir"
for relative in "${files[@]}"; do
    cp -p "$source_dir/$relative" "$target_dir/$relative"
done
printf 'Updated seven Swift files. Firebase, signing, icons and the Xcode project were not changed.\n'
printf 'Reopen CallRelay.xcodeproj, select your iPhone, then run with Command+R.\n'
