//! The hosted activity report (`/v1/analytics/active_user_v2`) is usage analytics: it sends the
//! app's version, the OS, how long the app has been open and how many things were generated on
//! which page. The hosted account does not need it to work, so it never runs while the window is
//! restricted (pod mode, or pod credentials not yet confirmed wiped), and no reporting session
//! spans a restricted period: the app drops the counts the moment its record becomes restricted,
//! and after the period the reporter starts a new session with a new token and a new clock, so
//! nothing about the time in pod mode reaches ArtCraft later.

/// What the activity reporter does on one pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActivityStep {
  /// The window is restricted: send nothing, and check again later.
  Hold,
  /// Send a report. With `new_session`, first drop the old session (token and clock), because the
  /// window has been restricted since the last report.
  Report { new_session: bool },
}

/// Remembers how many restricted periods the reporter has already accounted for.
///
/// `restricted_periods` is a counter the app raises each time its record becomes restricted
/// (including at start). A counter, rather than a sample of the current state, also catches a
/// restricted period that began and ended while the reporter slept between two reports.
#[derive(Clone, Copy, Debug, Default)]
pub struct ActivityGate {
  seen_periods: u64,
}

impl ActivityGate {
  pub fn step(&mut self, restricted: bool, restricted_periods: u64) -> ActivityStep {
    if restricted {
      return ActivityStep::Hold;
    }
    let new_session = restricted_periods != self.seen_periods;
    self.seen_periods = restricted_periods;
    ActivityStep::Report { new_session }
  }

  /// Whether a report prepared after the last `step` may still go out: the window has not become
  /// restricted since, not even briefly. Checked again right before sending, because preparing the
  /// report takes time in which pod mode can be entered.
  pub fn may_send(&self, restricted: bool, restricted_periods: u64) -> bool {
    !restricted && restricted_periods == self.seen_periods
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn nothing_is_reported_while_restricted() {
    let mut gate = ActivityGate::default();
    assert_eq!(gate.step(true, 1), ActivityStep::Hold);
    assert_eq!(gate.step(true, 1), ActivityStep::Hold);
  }

  #[test]
  fn an_ordinary_run_keeps_one_session() {
    let mut gate = ActivityGate::default();
    assert_eq!(gate.step(false, 0), ActivityStep::Report { new_session: false });
    assert_eq!(gate.step(false, 0), ActivityStep::Report { new_session: false });
  }

  #[test]
  fn the_first_report_after_a_restricted_period_starts_a_new_session_once() {
    let mut gate = ActivityGate::default();
    assert_eq!(gate.step(false, 0), ActivityStep::Report { new_session: false });
    assert_eq!(gate.step(true, 1), ActivityStep::Hold);
    assert_eq!(gate.step(false, 1), ActivityStep::Report { new_session: true });
    assert_eq!(gate.step(false, 1), ActivityStep::Report { new_session: false });
  }

  #[test]
  fn a_restricted_period_the_reporter_never_saw_still_starts_a_new_session() {
    let mut gate = ActivityGate::default();
    assert_eq!(gate.step(false, 0), ActivityStep::Report { new_session: false });
    // Pod mode was entered and left while the reporter slept.
    assert_eq!(gate.step(false, 1), ActivityStep::Report { new_session: true });
  }

  #[test]
  fn a_prepared_report_is_not_sent_once_the_window_has_become_restricted() {
    let mut gate = ActivityGate::default();
    assert_eq!(gate.step(false, 0), ActivityStep::Report { new_session: false });
    assert!(gate.may_send(false, 0));
    // Pod mode was entered while the report was being prepared.
    assert!(!gate.may_send(true, 1));
    // ...or entered and left again.
    assert!(!gate.may_send(false, 1));
    // The next pass starts a new session, whose report may go out.
    assert_eq!(gate.step(false, 1), ActivityStep::Report { new_session: true });
    assert!(gate.may_send(false, 1));
  }

  #[test]
  fn an_app_started_in_pod_mode_reports_only_after_leaving_and_in_a_new_session() {
    let mut gate = ActivityGate::default();
    assert_eq!(gate.step(true, 1), ActivityStep::Hold);
    assert_eq!(gate.step(false, 1), ActivityStep::Report { new_session: true });
  }
}
