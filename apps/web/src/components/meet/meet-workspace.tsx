"use client";

import { useEffect, useMemo, useState } from "react";
import { normalizeMeetingCode } from "@tamishra/meet-core";
import {
  saveMeetingAccess,
  WorkspaceMeetingGateway
} from "@tamishra/meet-core/workspace-gateway";
import styles from "./meet-workspace.module.css";

const GATEWAY_ORIGIN =
  process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN || "http://localhost:4100";

type RuntimeState = {
  status: "checking" | "ready" | "offline";
  mediaConfigured: boolean;
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

  useEffect(() => {
    let active = true;
    gateway
      .capabilities()
      .then((result) => {
        if (!active) return;
        setRuntime({
          status: "ready",
          mediaConfigured: result.mediaConfigured,
          persistence: result.persistence
        });
      })
      .catch(() => {
        if (!active) return;
        setRuntime({
          status: "offline",
          mediaConfigured: false,
          persistence: "unavailable"
        });
      });
    return () => {
      active = false;
    };
  }, [gateway]);

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

      window.location.assign(
        "/apps/meet/room?room=" +
          encodeURIComponent(result.meeting.roomName)
      );
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
      window.location.assign(
        "/apps/meet/room?room=" +
          encodeURIComponent(result.meeting.roomName)
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to join meeting."
      );
    } finally {
      setBusy("");
    }
  }

  const runtimeLabel =
    runtime.status === "checking"
      ? "Checking Workspace Meet"
      : runtime.status === "offline"
        ? "Gateway offline"
        : runtime.mediaConfigured
          ? "Native Workspace Meet ready"
          : "Gateway ready · LiveKit setup required";

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <a className={styles.brand} href="/">
          <span className={styles.brandMark}>T</span>
          <span>
            <strong>Tamishra Meet</strong>
            <small>Workspace-native meetings</small>
          </span>
        </a>

        <div
          className={
            runtime.status === "ready"
              ? styles.serviceState
              : runtime.status === "offline"
                ? styles.serviceStateOffline
                : styles.serviceStateChecking
          }
        >
          <span />
          <strong>{runtimeLabel}</strong>
        </div>

        <a className={styles.backLink} href="/">
          Workspace home
        </a>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>TAMISHRA MEET</p>
          <h1>Private meetings owned by Tamishra Workspace.</h1>
          <p className={styles.lead}>
            Create an instant meeting, schedule one for later, admit participants
            from a waiting room, and connect through the Workspace LiveKit
            runtime without depending on Google, Microsoft, or the older
            Tamishra training site.
          </p>

          <div className={styles.identityField}>
            <label htmlFor="meet-display-name">Your display name</label>
            <input
              id="meet-display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Enter your name"
              maxLength={100}
            />
          </div>

          <div className={styles.heroActions}>
            <button
              className={styles.primaryAction}
              disabled={busy !== "" || runtime.status === "offline"}
              onClick={() => void createMeeting("instant")}
            >
              {busy === "instant" ? "Creating…" : "Start meeting now"}
            </button>
            <button
              className={styles.secondaryAction}
              disabled={busy !== "" || runtime.status === "offline"}
              onClick={() => {
                document
                  .getElementById("schedule-meeting")
                  ?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              Schedule meeting
            </button>
          </div>

          {message && (
            <p className={styles.notice} role="status">
              {message}
            </p>
          )}
        </div>

        <div className={styles.joinCard}>
          <div className={styles.joinHeading}>
            <span>JOIN</span>
            <strong>Enter private meeting code</strong>
          </div>

          <div className={styles.codeInputWrap}>
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

          <button
            className={styles.joinButton}
            disabled={
              busy !== "" ||
              normalizeMeetingCode(joinCode).length !== 10 ||
              runtime.status === "offline"
            }
            onClick={() => void joinMeeting()}
          >
            {busy === "join" ? "Joining…" : "Join meeting"}
          </button>

          <div className={styles.joinMeta}>
            <span>Private access key generated after code verification</span>
            <span>Waiting-room policy enforced by Workspace gateway</span>
          </div>
        </div>
      </section>

      <section className={styles.builder} id="schedule-meeting">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>MEETING SETUP</p>
            <h2>Configure the room before you start.</h2>
          </div>
          <span className={styles.runtimeTag}>Gateway v0.2</span>
        </div>

        <div className={styles.builderGrid}>
          <div className={styles.builderPanel}>
            <label>
              Meeting title
              <input
                value={title}
                maxLength={160}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>

            <label>
              Schedule date & time
              <input
                type="datetime-local"
                value={scheduleAt}
                onChange={(event) => setScheduleAt(event.target.value)}
              />
            </label>

            <div className={styles.toggleGrid}>
              <label className={styles.toggleCard}>
                <input
                  type="checkbox"
                  checked={waitingRoom}
                  onChange={(event) => setWaitingRoom(event.target.checked)}
                />
                <span>
                  <strong>Waiting room</strong>
                  <small>Host admits participants before media access.</small>
                </span>
              </label>

              <label className={styles.toggleCard}>
                <input
                  type="checkbox"
                  checked={allowShare}
                  onChange={(event) => setAllowShare(event.target.checked)}
                />
                <span>
                  <strong>Participant screen share</strong>
                  <small>Store the policy with the room for media controls.</small>
                </span>
              </label>
            </div>

            <button
              className={styles.primaryAction}
              disabled={busy !== "" || runtime.status === "offline"}
              onClick={() => void createMeeting("scheduled")}
            >
              {busy === "scheduled" ? "Scheduling…" : "Create scheduled meeting"}
            </button>
          </div>

          <div className={styles.statusPanel}>
            <div>
              <span>Meeting service</span>
              <strong>
                {runtime.status === "ready" ? "Workspace gateway" : runtimeLabel}
              </strong>
            </div>
            <div>
              <span>Realtime media</span>
              <strong>
                {runtime.mediaConfigured ? "LiveKit configured" : "Needs LiveKit environment"}
              </strong>
            </div>
            <div>
              <span>Current persistence</span>
              <strong>{runtime.persistence}</strong>
            </div>
            <div>
              <span>Desktop / mobile</span>
              <strong>Shared web runtime through Tauri + Capacitor</strong>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.runtime}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>NATIVE FLOW</p>
            <h2>Meeting lifecycle now belongs to Workspace.</h2>
          </div>
        </div>

        <div className={styles.flow}>
          <article>
            <span className={styles.step}>01</span>
            <strong>Create</strong>
            <p>
              Workspace gateway generates the room, host capability key and a
              private 10-character join code.
            </p>
          </article>
          <article>
            <span className={styles.step}>02</span>
            <strong>Admit</strong>
            <p>
              Join-code verification creates a participant capability. The host
              can admit or deny waiting-room requests.
            </p>
          </article>
          <article>
            <span className={styles.step}>03</span>
            <strong>Connect</strong>
            <p>
              The gateway issues LiveKit media tokens only for active, admitted
              meeting participants.
            </p>
          </article>
        </div>
      </section>

      <section className={styles.migrationNote}>
        <div>
          <p className={styles.eyebrow}>HARDENING NEXT</p>
          <h2>Native runtime is established; persistence comes next.</h2>
        </div>
        <p>
          The current native gateway keeps meeting state in an ephemeral
          in-memory store so the room lifecycle can be exercised end to end
          while the Workspace database layer is being built. The next hardening
          block is durable meeting, membership, attendance, chat and recording
          persistence behind the same <code>@tamishra/meet-core</code> contract.
        </p>
      </section>
    </main>
  );
}
