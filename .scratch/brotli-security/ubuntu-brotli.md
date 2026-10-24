# Ubuntu Brotli update pending

Status: needs-info

Checked on 2026-10-25 for CVE-2026-111497.

The rebuilt `cot-linux-build:latest` and `cot-linux-builder:latest` images use
patched Node 24.22.1. Ubuntu 22.04 still supplies `libbrotli1` version
`1.0.9-2build6` on arm64. Rebuilding from the current repositories did not
provide a patched distribution library. This remains unresolved.

Ubuntu's tracker currently lists the package as "Needs evaluation":
https://ubuntu.com/security/CVE-2026-111497

When Ubuntu publishes its fixed package, rebuild the Linux toolchain with
`--pull --no-cache`, verify the installed package against Ubuntu's advisory,
and check whether desktop bundles carry a copy of the affected library.
Until then, keep this toolchain restricted to trusted build inputs and do not
use it to decode untrusted Brotli content. Pinning Node fixes Node's bundled
decoder; it does not fix the distribution library used by other programs.

The Cot production image was rebuilt and checked separately: it contains no
Brotli Python module or `/usr/lib/libbrotli*` library. The local website was
rebuilt and restarted with Alpine `brotli-libs` 1.2.1-r0.

Source changes have not been committed, pushed, or released. Remote CI,
published images, and released desktop artifacts still need a release from
the patched sources.
