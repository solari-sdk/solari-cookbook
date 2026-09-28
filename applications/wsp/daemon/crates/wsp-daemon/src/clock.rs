// SPDX-License-Identifier: AGPL-3.0-only
//! Wall-clock time as the node daemon stamps it: epoch milliseconds, and the ISO form Date.prototype.toISOString
//! writes, with three decimals and a Z.

use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Epoch milliseconds as `YYYY-MM-DDTHH:MM:SS.mmmZ`, by the civil-from-days arithmetic, so no calendar crate rides
/// along for one stamp.
pub(crate) fn iso_millis(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, minute, second) = (rem / 3600, rem % 3600 / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_millis_writes_what_to_iso_string_writes() {
        assert_eq!(iso_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_millis(1_788_609_840_000), "2026-09-05T12:04:00.000Z");
        assert_eq!(iso_millis(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        assert_eq!(iso_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
