// Compatibility alias for the old PTY inject tracker.
//
// Issue #952: `InFlightTracker` の counter / wait_idle / spawn 実装は
// TaskSupervisor に統合した。既存の `pty_inflight` 呼び出し名は Issue #630 の文脈で
// まだ読みやすいため、公開型名だけ残して移行差分を抑える。

pub type InFlightTracker = crate::task_supervisor::TaskSupervisor;
