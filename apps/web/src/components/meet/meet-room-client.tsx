"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LiveKitRoom,
  PreJoin,
  VideoConference
} from "@livekit/components-react";
import type { MeetingJoinContext } from "@tamishra/meet-core";
import {
  loadMeetingAccess,
  type MeetingAttendance,
  type MeetingParticipant,
  WorkspaceMeetingGateway
} from "@tamishra/meet-core/workspace-gateway";
import styles from "./meet-room.module.css";

const GATEWAY_ORIGIN =
  process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN || "http://localhost:4100";

type JoinChoices = {
  username?: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
  audioDeviceId?: string;
  videoDeviceId?: string;
};

export function MeetRoomClient() {
  const gateway = useMemo(
    () => new WorkspaceMeetingGateway(GATEWAY_ORIGIN),
    []
  );

  const [roomName, setRoomName] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [hostJoinCode, setHostJoinCode] = useState("");
  const [context, setContext] = useState<MeetingJoinContext | null>(null);
  const [participants, setParticipants] = useState<MeetingParticipant[]>([]);
  const [attendance, setAttendance] = useState<MeetingAttendance[]>([]);
  const [choices, setChoices] = useState<JoinChoices | null>(null);
  const [token, setToken] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");
  const [roomError, setRoomError] = useState("");
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(false);

  const isHost = context?.role === "host";

  const loadContext = useCallback(
    async (room: string, key: string) => {
      const result = await gateway.getContext(room, key);
      setContext(result);
      setError("");
      return result;
    },
    [gateway]
  );

  const loadParticipants = useCallback(
    async (room: string, key: string) => {
      const result = await gateway.listParticipants(room, key);
      setParticipants(result);
    },
    [gateway]
  );

  const loadAttendance = useCallback(
    async (room: string, key: string) => {
      const result = await gateway.listAttendance(room, key);
      setAttendance(result);
    },
    [gateway]
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const room = params.get("room")?.trim() ?? "";
    if (!room) {
      setError("Meeting room is missing.");
      setLoading(false);
      return;
    }

    const access = loadMeetingAccess(room);
    if (!access) {
      setError(
        "This browser does not have access to the room. Join again with the private meeting code."
      );
      setLoading(false);
      return;
    }

    setRoomName(room);
    setAccessKey(access.accessKey);
    setDisplayName(access.displayName);
    setHostJoinCode(access.joinCode ?? "");

    void loadContext(room, access.accessKey)
      .then((result) => {
        if (result.role === "host") {
          return Promise.all([
            loadParticipants(room, access.accessKey).catch(() => undefined),
            loadAttendance(room, access.accessKey).catch(() => undefined)
          ]);
        }
        return undefined;
      })
      .catch((reason) => {
        setError(
          reason instanceof Error ? reason.message : "Unable to load meeting."
        );
      })
      .finally(() => setLoading(false));
  }, [loadAttendance, loadContext, loadParticipants]);

  useEffect(() => {
    if (!roomName || !accessKey || !context || token) return;

    const shouldPoll =
      context.status === "scheduled" ||
      context.admissionStatus === "waiting";

    if (!shouldPoll) return;

    const timer = window.setInterval(() => {
      void loadContext(roomName, accessKey).catch(() => undefined);
    }, context.admissionStatus === "waiting" ? 2500 : 4000);

    return () => window.clearInterval(timer);
  }, [
    roomName,
    accessKey,
    context,
    context?.status,
    context?.admissionStatus,
    token,
    loadContext
  ]);

  useEffect(() => {
    if (!roomName || !accessKey || !isHost) return;

    const refresh = () => {
      void loadParticipants(roomName, accessKey).catch(() => undefined);
      void loadAttendance(roomName, accessKey).catch(() => undefined);
    };

    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [
    roomName,
    accessKey,
    isHost,
    loadParticipants,
    loadAttendance
  ]);

  useEffect(() => {
    if (!roomName || !accessKey || !connected) return;

    const beat = () => {
      void gateway.heartbeat(roomName, accessKey).catch(() => undefined);
    };
    const leave = () => {
      void gateway.leave(roomName, accessKey).catch(() => undefined);
    };

    beat();
    const timer = window.setInterval(beat, 30_000);
    window.addEventListener("pagehide", leave);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [roomName, accessKey, connected, gateway]);

  async function startMeeting() {
    if (!roomName || !accessKey) return;
    setError("");
    try {
      const result = await gateway.setLifecycle(roomName, accessKey, "start");
      setContext(result);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to start meeting."
      );
    }
  }

  async function endMeeting() {
    if (!roomName || !accessKey) return;
    setError("");
    try {
      await gateway.setLifecycle(roomName, accessKey, "end");
      window.location.assign("/apps/meet");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to end meeting."
      );
    }
  }

  async function updateAdmission(
    participantId: string,
    status: "admitted" | "denied"
  ) {
    if (!roomName || !accessKey) return;
    try {
      await gateway.setAdmission(roomName, accessKey, participantId, status);
      await loadParticipants(roomName, accessKey);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to update participant admission."
      );
    }
  }

  async function connect(values: JoinChoices) {
    if (!roomName || !accessKey || joining) return;
    setJoining(true);
    setError("");
    setChoices(values);
    try {
      const result = await gateway.issueToken(
        roomName,
        accessKey,
        values.username?.trim() || displayName
      );
      setToken(result.token);
      setServerUrl(result.url);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to join meeting."
      );
    } finally {
      setJoining(false);
    }
  }

  async function copyJoinCode() {
    if (!hostJoinCode) return;
    try {
      await navigator.clipboard.writeText(hostJoinCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Unable to copy private meeting code.");
    }
  }

  if (loading) {
    return (
      <main className={styles.gate}>
        <div className={styles.gateCard}>
          <span className={styles.loader} />
          <h1>Preparing Tamishra Meet…</h1>
          <p>Checking your Workspace meeting access.</p>
        </div>
      </main>
    );
  }

  if (!context || error && !roomName) {
    return (
      <main className={styles.gate}>
        <div className={styles.gateCard}>
          <p className={styles.eyebrow}>TAMISHRA MEET</p>
          <h1>Unable to open meeting</h1>
          <p>{error || "Meeting information is unavailable."}</p>
          <a className={styles.primaryLink} href="/apps/meet">
            Back to Meet
          </a>
        </div>
      </main>
    );
  }

  if (context.status === "ended" || context.status === "cancelled") {
    return (
      <main className={styles.gate}>
        <div className={styles.gateCard}>
          <p className={styles.eyebrow}>MEETING CLOSED</p>
          <h1>{context.title}</h1>
          <p>This meeting is no longer active.</p>
          <a className={styles.primaryLink} href="/apps/meet">
            Back to Tamishra Meet
          </a>
        </div>
      </main>
    );
  }

  if (isHost && context.status === "scheduled") {
    return (
      <main className={styles.gate}>
        <div className={styles.gateCard}>
          <p className={styles.eyebrow}>HOST STUDIO</p>
          <h1>{context.title}</h1>
          <p>
            This meeting is scheduled. Start it when you are ready; participants
            will remain outside until the room is live.
          </p>
          {context.scheduledStartAt && (
            <div className={styles.scheduleTime}>
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short"
              }).format(new Date(context.scheduledStartAt))}
            </div>
          )}
          <button className={styles.primaryButton} onClick={() => void startMeeting()}>
            Start meeting
          </button>
          <a className={styles.secondaryLink} href="/apps/meet">
            Back to Meet
          </a>
          {error && <p className={styles.error}>{error}</p>}
        </div>
      </main>
    );
  }

  if (!isHost && context.status !== "live") {
    return (
      <main className={styles.gate}>
        <div className={styles.gateCard}>
          <p className={styles.eyebrow}>WAITING FOR HOST</p>
          <h1>{context.title}</h1>
          <p>The host has not started this meeting yet. This page checks automatically.</p>
          <span className={styles.loader} />
          <a className={styles.secondaryLink} href="/apps/meet">
            Leave waiting room
          </a>
        </div>
      </main>
    );
  }

  if (
    !isHost &&
    context.status === "live" &&
    context.admissionStatus === "waiting"
  ) {
    return (
      <main className={styles.gate}>
        <div className={styles.gateCard}>
          <p className={styles.eyebrow}>WAITING ROOM</p>
          <h1>{context.title}</h1>
          <p>
            Your private code was accepted. The host can now admit you to the
            meeting.
          </p>
          <span className={styles.loader} />
          <a className={styles.secondaryLink} href="/apps/meet">
            Leave waiting room
          </a>
        </div>
      </main>
    );
  }

  if (!isHost && context.admissionStatus === "denied") {
    return (
      <main className={styles.gate}>
        <div className={styles.gateCard}>
          <p className={styles.eyebrow}>ACCESS NOT ADMITTED</p>
          <h1>{context.title}</h1>
          <p>The host did not admit this join request.</p>
          <a className={styles.primaryLink} href="/apps/meet">
            Back to Meet
          </a>
        </div>
      </main>
    );
  }

  if (!token || !serverUrl || !choices) {
    return (
      <main className={styles.prejoinPage}>
        <header className={styles.prejoinHeader}>
          <div>
            <p className={styles.eyebrow}>{isHost ? "HOST STUDIO" : "TAMISHRA MEET"}</p>
            <h1>{context.title}</h1>
          </div>
          <div className={styles.headerActions}>
            {isHost && hostJoinCode && (
              <button className={styles.codeButton} onClick={() => void copyJoinCode()}>
                <span>{copied ? "Copied" : "Private code"}</span>
                <strong>{hostJoinCode}</strong>
              </button>
            )}
            <span className={styles.roleBadge}>
              {isHost ? "Host" : "Participant"}
            </span>
          </div>
        </header>

        {error && <div className={styles.prejoinError}>{error}</div>}

        <div className={styles.prejoinShell}>
          <PreJoin
            defaults={{
              username: displayName,
              audioEnabled: true,
              videoEnabled: true
            }}
            persistUserChoices
            joinLabel={joining ? "Joining…" : "Join meeting"}
            micLabel="Microphone"
            camLabel="Camera"
            userLabel="Display name"
            onError={(reason) => setError(reason.message)}
            onSubmit={(values) => {
              if (!joining) void connect(values);
            }}
          />
        </div>

        <p className={styles.prejoinTip}>
          Camera and microphone stay under your control. Screen sharing is
          governed by this room&apos;s participant policy.
        </p>
      </main>
    );
  }

  const waitingParticipants = participants.filter(
    (participant) =>
      participant.role !== "host" && participant.admissionStatus === "waiting"
  );

  return (
    <LiveKitRoom
      token={token}
      serverUrl={serverUrl}
      connect
      audio={
        choices.audioEnabled
          ? choices.audioDeviceId
            ? { deviceId: choices.audioDeviceId }
            : true
          : false
      }
      video={
        choices.videoEnabled
          ? choices.videoDeviceId
            ? { deviceId: choices.videoDeviceId }
            : true
          : false
      }
      data-lk-theme="default"
      className={styles.liveRoot}
      onConnected={() => {
        setConnected(true);
        setRoomError("");
      }}
      onDisconnected={() => {
        setConnected(false);
        setRoomError("Meeting connection ended.");
      }}
      onError={(reason) => setRoomError(reason.message)}
      onMediaDeviceFailure={(failure, kind) =>
        setRoomError(
          "Media device error" +
            (kind ? " (" + kind + ")" : "") +
            ": " +
            String(failure || "unknown")
        )
      }
    >
      <header className={styles.liveHeader}>
        <div>
          <span className={styles.brandMark}>T</span>
          <div>
            <strong>{context.title}</strong>
            <small>{roomName}</small>
          </div>
        </div>
        <div className={styles.liveHeaderActions}>
          {isHost && hostJoinCode && (
            <button className={styles.compactCode} onClick={() => void copyJoinCode()}>
              {copied ? "Copied" : hostJoinCode}
            </button>
          )}
          {isHost && (
            <button className={styles.endButton} onClick={() => void endMeeting()}>
              End meeting
            </button>
          )}
          <a className={styles.leaveLink} href="/apps/meet">
            Leave
          </a>
        </div>
      </header>

      {roomError && <div className={styles.roomError}>{roomError}</div>}

      <div className={styles.liveLayout}>
        <section className={styles.conference}>
          <VideoConference />
        </section>

        {isHost && (
          <aside className={styles.hostPanel}>
            <div className={styles.hostPanelHeading}>
              <span>HOST CONTROL</span>
              <strong>Participants</strong>
            </div>

            {waitingParticipants.length > 0 && (
              <div className={styles.waitingGroup}>
                <span className={styles.groupLabel}>
                  Waiting · {waitingParticipants.length}
                </span>
                {waitingParticipants.map((participant) => (
                  <article className={styles.participantCard} key={participant.id}>
                    <div>
                      <strong>{participant.displayName}</strong>
                      <small>Waiting for admission</small>
                    </div>
                    <div>
                      <button
                        className={styles.admitButton}
                        onClick={() =>
                          void updateAdmission(participant.id, "admitted")
                        }
                      >
                        Admit
                      </button>
                      <button
                        className={styles.denyButton}
                        onClick={() =>
                          void updateAdmission(participant.id, "denied")
                        }
                      >
                        Deny
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}

            <div className={styles.attendanceGroup}>
              <span className={styles.groupLabel}>
                Attendance · {attendance.length}
              </span>
              {attendance.map((entry) => (
                <div className={styles.attendanceRow} key={entry.participantId}>
                  <span
                    className={
                      entry.leftAt
                        ? styles.attendanceDotAway
                        : styles.attendanceDot
                    }
                  />
                  <div>
                    <strong>{entry.displayName}</strong>
                    <small>
                      {entry.leftAt ? "Left" : "Connected"} · joined{" "}
                      {new Intl.DateTimeFormat(undefined, {
                        hour: "numeric",
                        minute: "2-digit"
                      }).format(new Date(entry.joinedAt))}
                    </small>
                  </div>
                </div>
              ))}
            </div>

            <div className={styles.allParticipants}>
              <span className={styles.groupLabel}>
                Room · {participants.length}
              </span>
              {participants.map((participant) => (
                <div className={styles.participantRow} key={participant.id}>
                  <span className={styles.participantAvatar}>
                    {participant.displayName
                      .split(" ")
                      .slice(0, 2)
                      .map((part) => part[0])
                      .join("")
                      .toUpperCase()}
                  </span>
                  <div>
                    <strong>{participant.displayName}</strong>
                    <small>
                      {participant.role} · {participant.admissionStatus}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>
    </LiveKitRoom>
  );
}
