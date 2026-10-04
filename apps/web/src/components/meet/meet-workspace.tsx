"use client";

import { useEffect, useMemo, useState } from "react";
import { normalizeMeetingCode } from "@tamishra/meet-core";
import {
  listMeetingAccesses,
  saveMeetingAccess,
  type MeetingHistoryItem,
  WorkspaceMeetingGateway
} from "@tamishra/meet-core/workspace-gateway";
import styles from "./meet-workspace.module.css";

const GATEWAY_ORIGIN =
  process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN || "http://localhost:4100";
const MEET_ROOM_PATH = "/workspace/apps/meet/room";

type RuntimeState = {
  status: "checking" | "ready" | "offline";
  mediaConfigured: boolean;
  recordingConfigured: boolean;
  persistence: string;
};

export function MeetWorkspace() {
  const gateway = useMemo(
    () => new WorkspaceMeetingGateway(GATEWAY_ORIGIN),
    []
  );

  const [runtime, setRuntime] = useState<RuntimeState>({
    status: "checking",
    mediaConfigured: false,
    recordingConfigured: false,
    persistence: "unknown"
  });
  const [displayName, setDisplayName] = useState("");
  const [title, setTitle] = useState("Tamishra Meeting");
  const [scheduleAt, setScheduleAt] = useState("");
  const [waitingRoom, setWaitingRoom] = useState(true);
  const [allowShare, setAllowShare] = useState(true);
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<MeetingHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  useEffect(() => {
    let active = true;
    gateway
      .capabilities()
      .then((result) => {
        if (!active) return;
        setRuntime({
          status: "ready",
          mediaConfigured: result.mediaConfigured,
          recordingConfigured: result.recordingConfigured,
          persistence: result.persistence
        });
      })
      .catch(() => {
        if (!active) return;
        setRuntime({
          status: "offline",
          mediaConfigured: false,
          recordingConfigured: false,
          persistence: "unavailable"
        });
      });
    return () => {
      active = false;
    };
  }, [gateway]);

  useEffect(() => {
    let active = true;
    const accesses = listMeetingAccesses();

    if (accesses.length === 0) {
      setHistory([]);
      setHistoryLoading(false);
      return () => {
        active = false;
      };
    }

    gateway
      .listHistory(
        accesses.map(({ roomName, accessKey }) => ({
          roomName,
          accessKey
        }))
      )
      .then((items) => {
        if (!active) return;
        setHistory(items.slice(0, 12));
      })
      .catch(() => {
        if (!active) return;
        setHistory([]);
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });

    return () => {
      active = false;
    };
  }, [gateway]);

  function openRoom(roomName: string) {
    window.location.assign(
      MEET_ROOM_PATH + "?room=" + encodeURIComponent(roomName)
    );
  }

  async function createMeeting(mode: "instant" | "scheduled") {
    const name = displayName.trim();
    if (!name) {
      setMessage("Enter your display name before creating a meeting.");
      return;
    }
    if (mode === "scheduled" && !scheduleAt) {
      setMessage("Choose a date and time for the scheduled meeting.");
      return;
    }

    setBusy(mode);
    setMessage("");
    try {
      const result = await gateway.createMeeting({
        mode,
        title: title.trim() || "Tamishra Meeting",
        scheduledStartAt:
          mode === "scheduled" ? new Date(scheduleAt).toISOString() : null,
        waitingRoomEnabled: waitingRoom,
        allowParticipantScreenShare: allowShare,
        displayName: name
      });

      saveMeetingAccess({
        roomName: result.meeting.roomName,
        accessKey: result.accessKey,
        role: "host",
        displayName: name,
        joinCode: result.joinCode
      });

      localStorage.setItem(
        "tamishra-workspace-meet:last-join-code",
        result.joinCode
      );

      openRoom(result.meeting.roomName);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to create meeting."
      );
    } finally {
      setBusy("");
    }
  }

  async function joinMeeting() {
    const code = normalizeMeetingCode(joinCode);
    const name = displayName.trim();
    if (!name) {
      setMessage("Enter your display name before joining.");
      return;
    }
    if (code.length !== 10) {
      setMessage("Enter the complete 10-character private meeting code.");
      return;
    }

    setBusy("join");
    setMessage("");
    try {
      const result = await gateway.joinMeeting(code, name);
      saveMeetingAccess({
        roomName: result.meeting.roomName,
        accessKey: result.accessKey,
        role: "participant",
        displayName: name
      });
      openRoom(result.meeting.roomName);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to join meeting."
      );
    } finally {
      setBusy("");
    }
  }

  function csvCell(value: string | number | null) {
    const text = value === null ? "" : String(value);
    return '"' + text.replaceAll('"', '""') + '"';
  }

  async function exportAttendance(item: MeetingHistoryItem) {
    const access = listMeetingAccesses().find(
      (entry) => entry.roomName === item.roomName
    );
    if (!access) {
      setMessage("Meeting access is no longer available on this device.");
      return;
    }

    setBusy("report:" + item.roomName);
    setMessage("");
    try {
      const report = await gateway.getAttendanceReport(
        item.roomName,
        access.accessKey
      );
      const lines = [
        [
          "Participant",
          "Joined at",
          "Last seen",
          "Left at",
          "Duration minutes"
        ].map(csvCell).join(","),
        ...report.rows.map((row) =>
          [
            row.displayName,
            row.joinedAt,
            row.lastSeenAt,
            row.leftAt,
            (row.durationMs / 60000).toFixed(2)
          ].map(csvCell).join(",")
        )
      ];
      const blob = new Blob([lines.join("\n")], {
        type: "text/csv;charset=utf-8"
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download =
        item.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") +
        "-attendance.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to export attendance."
      );
    } finally {
      setBusy("");
    }
  }

  const runtimeLabel =
    runtime.status === "checking"
      ? "Checking service"
      : runtime.status === "offline"
        ? "Service offline"
        : runtime.mediaConfigured
          ? "Meeting service ready"
          : "Media setup required";

  return (
    <main className={styles.page}>
      <div className={styles.consoleHeader}>
        <div>
          <h2>Meeting console</h2>
          <p>Start, join or schedule a Workspace meeting.</p>
        </div>
        <div
          className={`${styles.serviceIndicator} ${
            runtime.status === "offline"
              ? styles.offline
              : runtime.status === "checking"
                ? styles.checking
                : styles.online
          }`}
        >
          <span />
          {runtimeLabel}
        </div>
      </div>

      {message && (
        <div className={styles.notice} role="status">
          {message}
        </div>
      )}

      <section className={styles.identityBar}>
        <label htmlFor="meet-display-name">Display name</label>
        <input
          id="meet-display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Your name"
          maxLength={100}
        />
        <span>This name is shown to people in the meeting.</span>
      </section>

      <section className={styles.actionGrid}>
        <div className={styles.actionPanel}>
          <div className={styles.panelHeading}>
            <span className={styles.actionIcon}>＋</span>
            <div>
              <h3>Start a meeting</h3>
              <p>Create a room and enter immediately.</p>
            </div>
          </div>
          <label>
            Meeting title
            <input
              value={title}
              maxLength={160}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <button
            className={styles.primaryButton}
            disabled={busy !== "" || runtime.status === "offline"}
            onClick={() => void createMeeting("instant")}
          >
            {busy === "instant" ? "Creating…" : "Start now"}
          </button>
        </div>

        <div className={styles.actionPanel}>
          <div className={styles.panelHeading}>
            <span className={styles.actionIcon}>→</span>
            <div>
              <h3>Join a meeting</h3>
              <p>Use the 10-character private code.</p>
            </div>
          </div>
          <label>
            Meeting code
            <div className={styles.codeField}>
              <input
                aria-label="Private meeting code"
                autoComplete="one-time-code"
                maxLength={10}
                onChange={(event) =>
                  setJoinCode(normalizeMeetingCode(event.target.value))
                }
                placeholder="7KF9W2Q8MX"
                value={joinCode}
              />
              <span>{normalizeMeetingCode(joinCode).length}/10</span>
            </div>
          </label>
          <button
            className={styles.secondaryButton}
            disabled={
              busy !== "" ||
              normalizeMeetingCode(joinCode).length !== 10 ||
              runtime.status === "offline"
            }
            onClick={() => void joinMeeting()}
          >
            {busy === "join" ? "Joining…" : "Join"}
          </button>
        </div>

        <div className={styles.actionPanel} id="schedule-meeting">
          <div className={styles.panelHeading}>
            <span className={styles.actionIcon}>◷</span>
            <div>
              <h3>Schedule</h3>
              <p>Create a room for a specific time.</p>
            </div>
          </div>
          <label>
            Date and time
            <input
              type="datetime-local"
              value={scheduleAt}
              onChange={(event) => setScheduleAt(event.target.value)}
            />
          </label>
          <div className={styles.inlineOptions}>
            <label>
              <input
                type="checkbox"
                checked={waitingRoom}
                onChange={(event) => setWaitingRoom(event.target.checked)}
              />
              Waiting room
            </label>
            <label>
              <input
                type="checkbox"
                checked={allowShare}
                onChange={(event) => setAllowShare(event.target.checked)}
              />
              Participant screen share
            </label>
          </div>
          <button
            className={styles.secondaryButton}
            disabled={busy !== "" || runtime.status === "offline"}
            onClick={() => void createMeeting("scheduled")}
          >
            {busy === "scheduled" ? "Scheduling…" : "Schedule"}
          </button>
        </div>
      </section>

      <section className={styles.lowerGrid}>
        <div className={styles.recentPanel}>
          <div className={styles.sectionHeader}>
            <div>
              <h3>Recent meetings</h3>
              <p>Rooms created or joined on this device.</p>
            </div>
            <span>{historyLoading ? "Loading" : history.length}</span>
          </div>

          {historyLoading ? (
            <div className={styles.emptyState}>Loading meeting history…</div>
          ) : history.length === 0 ? (
            <div className={styles.emptyState}>
              No meetings yet. Start or join a meeting to see it here.
            </div>
          ) : (
            <div className={styles.meetingList}>
              {history.map((item) => (
                <article className={styles.meetingRow} key={item.roomName}>
                  <div className={styles.meetingMain}>
                    <div className={styles.meetingTitleRow}>
                      <strong>{item.title}</strong>
                      <span className={styles.statusTag}>{item.status}</span>
                    </div>
                    <span className={styles.meetingMeta}>
                      {new Intl.DateTimeFormat(undefined, {
                        dateStyle: "medium",
                        timeStyle: "short"
                      }).format(
                        new Date(
                          item.startedAt ??
                            item.scheduledStartAt ??
                            item.createdAt
                        )
                      )}
                      {" · "}
                      {item.role === "cohost" ? "Co-host" : item.role}
                    </span>
                    <span className={styles.metrics}>
                      {item.participantCount} people · {item.attendanceCount} attendance
                      {item.recordingCount > 0
                        ? ` · ${item.recordingCount} recordings`
                        : ""}
                    </span>
                  </div>

                  {item.role === "host" && item.joinCode ? (
                    <code className={styles.meetingCode}>{item.joinCode}</code>
                  ) : null}

                  <div className={styles.rowActions}>
                    <button onClick={() => openRoom(item.roomName)}>
                      {item.status === "ended" ? "Open" : "Rejoin"}
                    </button>
                    {(item.role === "host" || item.role === "cohost") && (
                      <button
                        disabled={busy !== ""}
                        onClick={() => void exportAttendance(item)}
                      >
                        {busy === "report:" + item.roomName
                          ? "Exporting…"
                          : "Attendance"}
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        <aside className={styles.systemPanel}>
          <div className={styles.sectionHeader}>
            <div>
              <h3>Service status</h3>
              <p>Workspace meeting runtime.</p>
            </div>
          </div>
          <dl className={styles.statusList}>
            <div>
              <dt>Gateway</dt>
              <dd>{runtime.status === "ready" ? "Connected" : runtimeLabel}</dd>
            </div>
            <div>
              <dt>Realtime media</dt>
              <dd>{runtime.mediaConfigured ? "Ready" : "Not configured"}</dd>
            </div>
            <div>
              <dt>Recording</dt>
              <dd>{runtime.recordingConfigured ? "Ready" : "Not configured"}</dd>
            </div>
            <div>
              <dt>Persistence</dt>
              <dd>{runtime.persistence}</dd>
            </div>
          </dl>
        </aside>
      </section>
    </main>
  );
}
