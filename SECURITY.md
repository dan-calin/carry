# Security policy

Carry handles project files and long-lived pairing secrets, so security reports
are treated as sensitive even while the project is in preview.

## Supported versions

Only the newest preview release and the current default branch receive security
fixes. Older builds may be asked to upgrade before a report is investigated.

## Reporting a vulnerability

Please use **Security -> Report a vulnerability** in this GitHub repository.
That creates a private report visible to the maintainers. If private
vulnerability reporting is not available, open an issue asking for a private
contact channel without including exploit details, secrets, logs, or affected
project data.

Include the affected version, operating system, impact, reproduction steps, and
the smallest safe proof of concept you can provide. Remove real invitation URLs,
pairing keys, device identifiers, usernames, and project contents first.

Do not test against another person's device, relay deployment, or data without
explicit permission. Please allow the maintainers time to reproduce and prepare
a fix before public disclosure.

## Release trust

Preview Windows packages are currently unsigned. Verify downloads against the
release's `SHA256SUMS.txt`. GitHub Actions builds tags only after the full test
suite passes, and refuses to replace assets on an existing release.
