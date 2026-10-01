"use client";

import {
  createMeetingCode,
  meetingUrl,
  normalizeMeetingCode,
  type MeetingChatMessage,
  type MeetingSummary
} from "@tamishra/meet-core";
import { FormEvent, useEffect, useRef, useState } from "react";
import styles from "./meet.module.css";

type View = "home" | "lobby" | "room";

const formatClock = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(iso));

export default function MeetPage() {
  const [view, setView] = useState<View>("home");
  const [roomCode, setRoomCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [displayName, setDisplayName] = useState("Deepak Kumar");
  const [isHost, setIsHost] = useState(false);

  const [microphoneOn, setMicrophoneOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [screenSharing, setScreenSharing] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [sidePanel, setSidePanel] = useState<"people" | "chat" | "details" | null>("people");
  const [mediaError, setMediaError] = useState("");
  const [copyState, setCopyState] = useState("Copy invite");

  const [chatDraft, setChatDraft] = useState("");
  const [messages, setMessages] = useState<MeetingChatMessage[]>([]);
  const [scheduled, setScheduled] = useState<MeetingSummary[]>([]);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleTitle, setScheduleTitle] = useState("Team meeting");
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleDuration, setScheduleDuration] = useState(45);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const room = normalizeMeetingCode(params.get("room") ?? "");
    if (room) {
      setRoomCode(room);
      setJoinCode(room);
      setIsHost(false);
      setView("lobby");
    }
  }, []);

  useEffect(() => {
    return () => {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      displayStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function attachPreview(stream: MediaStream | null) {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }

  async function prepareDevices() {
    setMediaError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setMediaError("Camera and microphone access are not available in this browser.");
      return;
    }

    try {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true
      });
      mediaStreamRef.current = stream;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = microphoneOn;
      });
      stream.getVideoTracks().forEach((track) => {
        track.enabled = cameraOn;
      });
      attachPreview(stream);
    } catch {
      setMediaError(
        "Camera or microphone permission was blocked. You can still continue and enable devices later."
      );
    }
  }

  function openLobby(code: string, host: boolean) {
    const normalized = normalizeMeetingCode(code);
    if (!normalized) return;

    setRoomCode(normalized);
    setJoinCode(normalized);
    setIsHost(host);
    setView("lobby");
    setSidePanel("people");
    window.history.replaceState({}, "", meetingUrl(window.location.href, normalized));
  }

  function startInstantMeeting() {
    openLobby(createMeetingCode(), true);
  }

  function joinMeeting(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeMeetingCode(joinCode);
    if (normalized.length < 5) return;
    openLobby(normalized, false);
  }

  function enterRoom() {
    setView("room");
    setMessages([
      {
        id: crypto.randomUUID(),
        senderId: "system",
        senderName: "Tamishra Meet",
        body: "You joined the meeting.",
        createdAt: new Date().toISOString()
      }
    ]);
  }

  function toggleMicrophone() {
    const next = !microphoneOn;
    setMicrophoneOn(next);
    mediaStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = next;
    });
  }

  function toggleCamera() {
    const next = !cameraOn;
    setCameraOn(next);
    mediaStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = next;
    });
  }

  async function toggleScreenShare() {
    if (screenSharing) {
      displayStreamRef.current?.getTracks().forEach((track) => track.stop());
      displayStreamRef.current = null;
      setScreenSharing(false);
      attachPreview(mediaStreamRef.current);
      return;
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      setMediaError("Screen sharing is not available in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      });
      displayStreamRef.current = stream;
      setScreenSharing(true);
      attachPreview(stream);

      const [videoTrack] = stream.getVideoTracks();
      if (videoTrack) {
        videoTrack.onended = () => {
          displayStreamRef.current = null;
          setScreenSharing(false);
          attachPreview(mediaStreamRef.current);
        };
      }
    } catch {
      // The native picker can be intentionally cancelled.
    }
  }

  async function copyInvite() {
    const url = meetingUrl(window.location.href, roomCode);
    await navigator.clipboard.writeText(url);
    setCopyState("Copied");
    window.setTimeout(() => setCopyState("Copy invite"), 1600);
  }

  function sendMessage(event: FormEvent) {
    event.preventDefault();
    const body = chatDraft.trim();
    if (!body) return;

    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        senderId: "local-user",
        senderName: displayName || "You",
        body,
        createdAt: new Date().toISOString()
      }
    ]);
    setChatDraft("");
  }

  function leaveMeeting() {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    displayStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    displayStreamRef.current = null;
    attachPreview(null);
    setScreenSharing(false);
    setHandRaised(false);
    setMessages([]);
    setRoomCode("");
    setJoinCode("");
    setView("home");
    window.history.replaceState({}, "", window.location.pathname);
  }

  function createScheduledMeeting(event: FormEvent) {
    event.preventDefault();
    const startsAt = scheduleAt ? new Date(scheduleAt) : new Date(Date.now() + 30 * 60 * 1000);
    const item: MeetingSummary = {
      id: createMeetingCode(),
      title: scheduleTitle.trim() || "Meeting",
      startsAt: startsAt.toISOString(),
      durationMinutes: scheduleDuration,
      hostName: displayName || "You",
      participantCount: 1
    };

    setScheduled((current) => [item, ...current]);
    setScheduleOpen(false);
  }

  const localInitials = (displayName || "You")
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  if (view === "home") {
    return (
      <main className={styles.app}>
        <header className={styles.header}>
          <a className={styles.brand} href="/">
            <span className={styles.brandMark}>T</span>
            <span>
              <strong>Tamishra Meet</strong>
              <small>Workspace collaboration</small>
            </span>
          </a>
          <nav className={styles.headerNav} aria-label="Meeting navigation">
            <a className={styles.activeNav} href="/apps/meet">Meet</a>
            <a href="/">Workspace</a>
          </nav>
          <div className={styles.identity}>
            <span className={styles.presenceDot} />
            <span>{displayName || "Guest"}</span>
            <span className={styles.avatar}>{localInitials}</span>
          </div>
        </header>

        <section className={styles.home}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>TAMISHRA MEET</p>
            <h1>Meet, present and make decisions without leaving your workspace.</h1>
            <p className={styles.lead}>
              Fast browser meetings with device controls, screen sharing, in-meeting chat,
              attendance-ready participant state and links into Tamishra Notes.
            </p>

            <div className={styles.primaryActions}>
              <button className={styles.primaryButton} onClick={startInstantMeeting}>
                New meeting
              </button>
              <button className={styles.secondaryButton} onClick={() => setScheduleOpen(true)}>
                Schedule
              </button>
            </div>

            <form className={styles.joinBar} onSubmit={joinMeeting}>
              <label htmlFor="meeting-code">Join with a meeting code</label>
              <div>
                <input
                  id="meeting-code"
                  value={joinCode}
                  onChange={(event) => setJoinCode(normalizeMeetingCode(event.target.value))}
                  placeholder="ABC-DEF-GHI"
                  autoComplete="off"
                />
                <button type="submit" disabled={joinCode.length < 5}>Join</button>
              </div>
            </form>
          </div>

          <div className={styles.heroVisual} aria-label="Meeting preview">
            <div className={styles.visualTop}>
              <span>Design review</span>
              <span className={styles.livePill}>Live workspace</span>
            </div>
            <div className={styles.peoplePreview}>
              <div className={styles.personTile}>
                <span className={styles.largeAvatar}>DK</span>
                <small>Host</small>
              </div>
              <div className={styles.personTileAlt}>
                <span className={styles.largeAvatarAlt}>AS</span>
                <small>Participant</small>
              </div>
            </div>
            <div className={styles.visualControls}>
              <span>Mic</span>
              <span>Camera</span>
              <span>Present</span>
              <span>Chat</span>
            </div>
          </div>
        </section>

        <section className={styles.dashboard}>
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>UPCOMING</p>
              <h2>Your meetings</h2>
            </div>
            <span>{scheduled.length} scheduled</span>
          </div>

          {scheduled.length ? (
            <div className={styles.meetingList}>
              {scheduled.map((meeting) => (
                <article className={styles.meetingCard} key={meeting.id}>
                  <div className={styles.dateBadge}>
                    <strong>{new Date(meeting.startsAt).getDate()}</strong>
                    <span>
                      {new Intl.DateTimeFormat(undefined, { month: "short" }).format(
                        new Date(meeting.startsAt)
                      )}
                    </span>
                  </div>
                  <div className={styles.meetingMeta}>
                    <strong>{meeting.title}</strong>
                    <span>
                      {formatClock(meeting.startsAt)} · {meeting.durationMinutes} min · {meeting.id}
                    </span>
                  </div>
                  <button onClick={() => openLobby(meeting.id, true)}>Open</button>
                </article>
              ))}
            </div>
          ) : (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>◌</span>
              <strong>No meetings scheduled yet</strong>
              <p>Create one here; calendar synchronization can plug into the same meeting record later.</p>
            </div>
          )}
        </section>

        <section className={styles.capabilityGrid}>
          <article>
            <span>01</span>
            <strong>Present clearly</strong>
            <p>Native browser screen sharing with a dedicated presentation state.</p>
          </article>
          <article>
            <span>02</span>
            <strong>Keep context together</strong>
            <p>Meeting chat and Notes integration points live inside one workspace.</p>
          </article>
          <article>
            <span>03</span>
            <strong>Control participation</strong>
            <p>Host-ready permission and participant models are shared through meet-core.</p>
          </article>
        </section>

        {scheduleOpen && (
          <div className={styles.modalBackdrop} onMouseDown={() => setScheduleOpen(false)}>
            <form
              className={styles.scheduleModal}
              onSubmit={createScheduledMeeting}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className={styles.modalHeading}>
                <div>
                  <p className={styles.eyebrow}>SCHEDULE</p>
                  <h2>New meeting</h2>
                </div>
                <button type="button" onClick={() => setScheduleOpen(false)} aria-label="Close">
                  ×
                </button>
              </div>

              <label>
                Meeting title
                <input
                  value={scheduleTitle}
                  onChange={(event) => setScheduleTitle(event.target.value)}
                  autoFocus
                />
              </label>
              <label>
                Date & time
                <input
                  type="datetime-local"
                  value={scheduleAt}
                  onChange={(event) => setScheduleAt(event.target.value)}
                />
              </label>
              <label>
                Duration
                <select
                  value={scheduleDuration}
                  onChange={(event) => setScheduleDuration(Number(event.target.value))}
                >
                  <option value={30}>30 minutes</option>
                  <option value={45}>45 minutes</option>
                  <option value={60}>1 hour</option>
                  <option value={90}>1 hour 30 minutes</option>
                </select>
              </label>
              <button className={styles.primaryButton} type="submit">Create meeting</button>
            </form>
          </div>
        )}
      </main>
    );
  }

  if (view === "lobby") {
    return (
      <main className={styles.lobbyPage}>
        <header className={styles.lobbyHeader}>
          <a className={styles.brand} href="/">
            <span className={styles.brandMark}>T</span>
            <span>
              <strong>Tamishra Meet</strong>
              <small>Pre-join</small>
            </span>
          </a>
          <span className={styles.roomCode}>Room {roomCode}</span>
        </header>

        <section className={styles.lobbyGrid}>
          <div className={styles.previewCard}>
            <div className={styles.videoStage}>
              <video ref={videoRef} autoPlay muted playsInline />
              {!cameraOn && !screenSharing && (
                <div className={styles.cameraOff}>
                  <span>{localInitials}</span>
                  <small>Camera is off</small>
                </div>
              )}
              <div className={styles.previewName}>{displayName || "You"}</div>
            </div>

            <div className={styles.deviceControls}>
              <button
                className={microphoneOn ? styles.deviceButton : styles.deviceButtonOff}
                onClick={toggleMicrophone}
              >
                {microphoneOn ? "Microphone on" : "Microphone off"}
              </button>
              <button
                className={cameraOn ? styles.deviceButton : styles.deviceButtonOff}
                onClick={toggleCamera}
              >
                {cameraOn ? "Camera on" : "Camera off"}
              </button>
              <button className={styles.deviceButton} onClick={prepareDevices}>
                Connect devices
              </button>
            </div>
          </div>

          <div className={styles.joinPanel}>
            <p className={styles.eyebrow}>{isHost ? "HOST LOBBY" : "READY TO JOIN"}</p>
            <h1>{isHost ? "Your meeting is ready." : "Check your setup before joining."}</h1>
            <p>
              Choose how you want to appear, then enter the room. Camera and microphone stay
              under your control.
            </p>

            <label className={styles.nameField}>
              Display name
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Your name"
              />
            </label>

            {mediaError && <div className={styles.mediaWarning}>{mediaError}</div>}

            <div className={styles.joinActions}>
              <button className={styles.primaryButton} onClick={enterRoom}>
                Join now
              </button>
              <button className={styles.secondaryButton} onClick={copyInvite}>
                {copyState}
              </button>
            </div>

            <button className={styles.backLink} onClick={leaveMeeting}>
              Back to Meet
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.roomPage}>
      <header className={styles.roomHeader}>
        <div>
          <span className={styles.brandMarkSmall}>T</span>
          <strong>Tamishra Meet</strong>
        </div>
        <div className={styles.roomTitle}>
          <strong>{isHost ? "My meeting" : "Meeting"}</strong>
          <span>{roomCode}</span>
        </div>
        <button className={styles.inviteButton} onClick={copyInvite}>{copyState}</button>
      </header>

      <div className={styles.roomLayout}>
        <section className={styles.stageArea}>
          <div className={styles.mainStage}>
            <video ref={videoRef} autoPlay muted playsInline />
            {!cameraOn && !screenSharing && (
              <div className={styles.roomCameraOff}>
                <span>{localInitials}</span>
                <strong>{displayName || "You"}</strong>
              </div>
            )}
            {screenSharing && <span className={styles.presentingBadge}>You are presenting</span>}
            <div className={styles.selfLabel}>
              <span>{displayName || "You"}</span>
              <small>{isHost ? "Host" : "You"}</small>
            </div>
          </div>

          {mediaError && <div className={styles.roomWarning}>{mediaError}</div>}

          <div className={styles.roomControls}>
            <div className={styles.controlCluster}>
              <button
                className={microphoneOn ? styles.controlButton : styles.controlButtonOff}
                onClick={toggleMicrophone}
                title="Toggle microphone"
              >
                <strong>Mic</strong>
                <span>{microphoneOn ? "On" : "Off"}</span>
              </button>
              <button
                className={cameraOn ? styles.controlButton : styles.controlButtonOff}
                onClick={toggleCamera}
                title="Toggle camera"
              >
                <strong>Cam</strong>
                <span>{cameraOn ? "On" : "Off"}</span>
              </button>
              <button
                className={screenSharing ? styles.controlButtonActive : styles.controlButton}
                onClick={toggleScreenShare}
                title="Share screen"
              >
                <strong>Share</strong>
                <span>{screenSharing ? "Stop" : "Screen"}</span>
              </button>
              <button
                className={handRaised ? styles.controlButtonActive : styles.controlButton}
                onClick={() => setHandRaised((current) => !current)}
                title="Raise hand"
              >
                <strong>Hand</strong>
                <span>{handRaised ? "Raised" : "Raise"}</span>
              </button>
            </div>

            <div className={styles.controlCluster}>
              <button
                className={sidePanel === "people" ? styles.controlButtonActive : styles.controlButton}
                onClick={() => setSidePanel(sidePanel === "people" ? null : "people")}
              >
                <strong>People</strong>
                <span>1</span>
              </button>
              <button
                className={sidePanel === "chat" ? styles.controlButtonActive : styles.controlButton}
                onClick={() => setSidePanel(sidePanel === "chat" ? null : "chat")}
              >
                <strong>Chat</strong>
                <span>{messages.length}</span>
              </button>
              <button
                className={sidePanel === "details" ? styles.controlButtonActive : styles.controlButton}
                onClick={() => setSidePanel(sidePanel === "details" ? null : "details")}
              >
                <strong>Info</strong>
                <span>Room</span>
              </button>
              <button className={styles.leaveButton} onClick={leaveMeeting}>
                Leave
              </button>
            </div>
          </div>
        </section>

        {sidePanel && (
          <aside className={styles.sidePanel}>
            <div className={styles.panelHeading}>
              <div>
                <p className={styles.eyebrow}>
                  {sidePanel === "people" ? "PARTICIPANTS" : sidePanel === "chat" ? "MESSAGES" : "MEETING"}
                </p>
                <h2>
                  {sidePanel === "people" ? "People" : sidePanel === "chat" ? "Meeting chat" : "Details"}
                </h2>
              </div>
              <button onClick={() => setSidePanel(null)} aria-label="Close panel">×</button>
            </div>

            {sidePanel === "people" && (
              <div className={styles.peoplePanel}>
                {isHost && (
                  <div className={styles.hostNotice}>
                    <strong>Host controls</strong>
                    <p>Lobby admission and remote participant controls connect here when the media service is attached.</p>
                  </div>
                )}

                <div className={styles.participantRow}>
                  <span className={styles.avatar}>{localInitials}</span>
                  <div>
                    <strong>{displayName || "You"} (you)</strong>
                    <span>{isHost ? "Host" : "Participant"}</span>
                  </div>
                  <small>{microphoneOn ? "Mic" : "Muted"} · {cameraOn ? "Cam" : "No cam"}</small>
                </div>

                <button className={styles.panelAction} onClick={copyInvite}>
                  Invite people
                </button>
              </div>
            )}

            {sidePanel === "chat" && (
              <div className={styles.chatPanel}>
                <div className={styles.messageList}>
                  {messages.map((message) => (
                    <article key={message.id} className={styles.message}>
                      <div>
                        <strong>{message.senderName}</strong>
                        <time>{formatClock(message.createdAt)}</time>
                      </div>
                      <p>{message.body}</p>
                    </article>
                  ))}
                </div>
                <form className={styles.chatComposer} onSubmit={sendMessage}>
                  <textarea
                    value={chatDraft}
                    onChange={(event) => setChatDraft(event.target.value)}
                    placeholder="Message everyone"
                    rows={3}
                  />
                  <button type="submit">Send</button>
                </form>
              </div>
            )}

            {sidePanel === "details" && (
              <div className={styles.detailsPanel}>
                <div>
                  <span>Meeting code</span>
                  <strong>{roomCode}</strong>
                </div>
                <div>
                  <span>Your role</span>
                  <strong>{isHost ? "Host" : "Participant"}</strong>
                </div>
                <div>
                  <span>Security</span>
                  <strong>Browser permissions + host policy</strong>
                </div>
                <button className={styles.panelAction} onClick={copyInvite}>{copyState}</button>
                <a className={styles.notesLink} href="/apps/notes">
                  Open meeting notes
                  <span>↗</span>
                </a>
              </div>
            )}
          </aside>
        )}
      </div>
    </main>
  );
}
