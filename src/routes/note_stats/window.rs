//! Authoritative coverage and subtotals of the returned rolling daily series.

use std::collections::{BTreeMap, HashMap};

use chrono::NaiveDate;
use serde::Serialize;

use super::DailyRow;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DailyWindow {
    pub scope: &'static str,
    pub start: String,
    pub end: String,
    pub monthly_subtotals: Vec<MonthSubtotal>,
    pub peak_views: Option<PeakViews>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakViews {
    pub value: i64,
    pub dates: Vec<NaiveDate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthSubtotal {
    pub month: String,
    pub start: NaiveDate,
    pub end: NaiveDate,
    pub views: i64,
    pub likes: i64,
    pub favorites: i64,
    pub comments: i64,
    pub peak_views: Option<PeakViews>,
}

fn observe_peak(peak: &mut Option<PeakViews>, date: NaiveDate, views: i64) {
    match peak {
        Some(current) if views < current.value => {}
        Some(current) if views == current.value => current.dates.push(date),
        _ => {
            *peak = Some(PeakViews {
                value: views,
                dates: vec![date],
            })
        }
    }
}

pub(super) fn summarize(
    daily: &HashMap<NaiveDate, DailyRow>,
    start: NaiveDate,
    end: NaiveDate,
) -> DailyWindow {
    let mut months: BTreeMap<String, MonthSubtotal> = BTreeMap::new();
    let mut peak_views = None;
    for (date, row) in daily {
        observe_peak(&mut peak_views, *date, row.views);
        let month = date.format("%Y-%m").to_string();
        let subtotal = months.entry(month.clone()).or_insert(MonthSubtotal {
            month,
            start: *date,
            end: *date,
            views: 0,
            likes: 0,
            favorites: 0,
            comments: 0,
            peak_views: None,
        });
        subtotal.start = subtotal.start.min(*date);
        subtotal.end = subtotal.end.max(*date);
        subtotal.views += row.views;
        subtotal.likes += row.likes;
        subtotal.favorites += row.favorites;
        subtotal.comments += row.comments;
        observe_peak(&mut subtotal.peak_views, *date, row.views);
    }
    let mut monthly_subtotals: Vec<_> = months.into_values().collect();
    for peak in std::iter::once(&mut peak_views)
        .chain(
            monthly_subtotals
                .iter_mut()
                .map(|month| &mut month.peak_views),
        )
        .flatten()
    {
        peak.dates.sort_unstable();
    }
    DailyWindow {
        scope: "rolling_window",
        start: start.to_string(),
        end: end.to_string(),
        monthly_subtotals,
        peak_views,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subtotals_preserve_window_boundaries_zeros_and_all_metrics() {
        let start = NaiveDate::from_ymd_opt(2026, 10, 31).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 11, 2).unwrap();
        let daily: HashMap<_, _> = [
            (
                start,
                DailyRow {
                    views: 2,
                    likes: 3,
                    favorites: 4,
                    comments: 5,
                    ..Default::default()
                },
            ),
            (
                end.pred_opt().unwrap(),
                DailyRow {
                    views: 7,
                    ..Default::default()
                },
            ),
            (end, DailyRow::default()),
        ]
        .into_iter()
        .collect();
        let result = summarize(&daily, start, end);
        assert_eq!(result.scope, "rolling_window");
        assert_eq!(result.start, "2026-10-31");
        assert_eq!(result.end, "2026-11-02");
        assert_eq!(result.monthly_subtotals.len(), 2);
        let october = &result.monthly_subtotals[0];
        assert_eq!(
            (
                october.views,
                october.likes,
                october.favorites,
                october.comments
            ),
            (2, 3, 4, 5)
        );
        let november = &result.monthly_subtotals[1];
        assert_eq!(november.views, 7);
        assert_eq!(november.end, end);
        let wire = serde_json::to_value(result).unwrap();
        assert_eq!(wire["monthlySubtotals"][1]["start"], "2026-11-01");
        assert!(wire.get("fullMonthTotals").is_none());
    }

    #[test]
    fn zero_window_still_has_coverage_and_months_do_not_merge_across_years() {
        let start = NaiveDate::from_ymd_opt(2026, 12, 31).unwrap();
        let end = NaiveDate::from_ymd_opt(2027, 1, 1).unwrap();
        let daily = [(start, DailyRow::default()), (end, DailyRow::default())].into();
        let result = summarize(&daily, start, end);
        assert_eq!(
            result
                .monthly_subtotals
                .iter()
                .map(|row| row.month.as_str())
                .collect::<Vec<_>>(),
            vec!["2026-12", "2027-01"]
        );
        assert!(result.monthly_subtotals.iter().all(|row| row.views == 0));
        assert_eq!(result.peak_views.as_ref().unwrap().value, 0);
        assert_eq!(result.peak_views.as_ref().unwrap().dates, vec![start, end]);
    }

    #[test]
    fn peaks_preserve_ties_and_cannot_leak_between_months() {
        let date = |month, day| NaiveDate::from_ymd_opt(2026, month, day).unwrap();
        let daily = [
            (
                date(10, 31),
                DailyRow {
                    views: 90,
                    ..Default::default()
                },
            ),
            (
                date(11, 1),
                DailyRow {
                    views: 7,
                    ..Default::default()
                },
            ),
            (
                date(11, 3),
                DailyRow {
                    views: 7,
                    ..Default::default()
                },
            ),
            (date(11, 2), DailyRow::default()),
        ]
        .into();
        let result = summarize(&daily, date(10, 31), date(11, 3));
        let peak = result.peak_views.unwrap();
        assert_eq!(peak.value, 90);
        assert_eq!(peak.dates, vec![date(10, 31)]);
        let november = result.monthly_subtotals.last().unwrap();
        assert_eq!(november.views, 14);
        let peak = november.peak_views.as_ref().unwrap();
        assert_eq!(peak.value, 7);
        assert_eq!(peak.dates, vec![date(11, 1), date(11, 3)]);
        let empty = summarize(&HashMap::new(), date(11, 1), date(11, 3));
        assert!(empty.peak_views.is_none());
    }
}
