"use client";

import { useMemo, useState } from "react";
import {
  normalizeMeetingCode,
  tamishraMeetCapabilities
} from "@tamishra/meet-core";
import { TamishraMeetBridge } from "@tamishra/meet-core/tamishra-bridge";
import styles from "./meet-workspace.module.css";

const DEFAULT_MEET_ORIGIN =
  process.env.NEXT_PUBLIC_TAMISHRA_MEET_ORIGIN || "https://www.tamishra.in";

const capabilityCards = [
  {
    title: "Secure access",
    detail: "Private 10-character joining codes, signed-in access and meeting membership checks.",
    enabled: tamishraMeetCapabilities.privateCodes
  },
  {
    title: "Professional lobby",
    detail: "Waiting-room admission lets the host control entry before participants connect.",
    enabled: tamishraMeetCapabilities.waitingRoom
  },
  {
    title: "Present from anywhere",
    detail: "Camera, microphone and presenter screen sharing use the existing LiveKit meeting runtime.",
    enabled: tamishraMeetCapabilities.screenShare
  },
  {
    title: "Live collaboration",
    detail: "Persistent chat, reactions, hand raise and participant controls stay inside the meeting.",
    enabled: tamishraMeetCapabilities.chat
  },
  {
    title: "Attendance",
    detail: "The existing meeting runtime tracks attendance and participant state for the session.",
    enabled: tamishraMeetCapabilities.attendance
  },
  {
    title: "Recording ready",
    detail: "Recording, consent and retention hooks are already part of the hardened Tamishra Live stack.",
    enabled: tamishraMeetCapabilities.recording
  }
];

export function MeetWorkspace() {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");

  const bridge = useMemo(
    () => new TamishraMeetBridge(DEFAULT_MEET_ORIGIN),
    []
  );

  const normalizedCode = normalizeMeetingCode(code);
  const canJoin = normalizedCode.length === 10;

  function openMeet(codeValue?: string) {
    const target = bridge.homeUrl(codeValue);
    window.location.assign(target);
  }

  async function copyMeetHome() {
    try {
      await navigator.clipboard.writeText(bridge.homeUrl());
      setMessage("Tamishra Meet link copied.");
    } catch {
      setMessage(bridge.homeUrl());
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <a className={styles.brand} href="/">
          <span className={styles.brandMark}>T</span>
          <span>
            <strong>Tamishra Meet</strong>
            <small>Workspace</small>
          </span>
        </a>

        <div className={styles.serviceState}>
          <span />
          <strong>Existing Tamishra meeting system</strong>
        </div>

        <a className={styles.backLink} href="/">
          Workspace home
        </a>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>TAMISHRA MEET</p>
          <h1>The meeting system we already built, now inside Workspace.</h1>
          <p className={styles.lead}>
            Workspace Meet uses the existing Tamishra meeting product as its
            source of truth: private codes, lobby admission, LiveKit video,
            screen sharing, chat, reactions, host controls, attendance and
            recording infrastructure.
          </p>

          <div className={styles.heroActions}>
            <button className={styles.primaryAction} onClick={() => openMeet()}>
              Start or schedule meeting
            </button>
            <button className={styles.secondaryAction} onClick={copyMeetHome}>
              Copy Meet link
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
              inputMode="text"
              maxLength={10}
              onChange={(event) =>
                setCode(normalizeMeetingCode(event.target.value))
              }
              placeholder="7KF9W2Q8MX"
              value={code}
            />
            <span>{normalizedCode.length}/10</span>
          </div>

          <button
            className={styles.joinButton}
            disabled={!canJoin}
            onClick={() => openMeet(normalizedCode)}
          >
            Join meeting
          </button>

          <p>
            The existing Tamishra identity and meeting-access checks continue
            to protect the room.
          </p>
        </div>
      </section>

      <section className={styles.runtime}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>EXISTING RUNTIME</p>
            <h2>Reuse what is already production-built.</h2>
          </div>
          <span className={styles.runtimeTag}>Tamishra Live + LiveKit</span>
        </div>

        <div className={styles.flow}>
          <article>
            <span className={styles.step}>01</span>
            <strong>Create or schedule</strong>
            <p>
              The existing Meet API creates a generic meeting, host membership,
              private join code and moderation policy.
            </p>
          </article>
          <article>
            <span className={styles.step}>02</span>
            <strong>Pre-join & lobby</strong>
            <p>
              Participants check camera and microphone, then wait for host
              admission when the lobby is enabled.
            </p>
          </article>
          <article>
            <span className={styles.step}>03</span>
            <strong>Live room</strong>
            <p>
              LiveKit handles realtime media while Tamishra manages chat,
              attendance, moderation, reactions and lifecycle state.
            </p>
          </article>
        </div>
      </section>

      <section className={styles.capabilities}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>CAPABILITIES</p>
            <h2>Already present in the Tamishra system.</h2>
          </div>
        </div>

        <div className={styles.capabilityGrid}>
          {capabilityCards.map((item, index) => (
            <article key={item.title}>
              <div className={styles.cardTop}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <span className={styles.ready}>
                  {item.enabled ? "Ready" : "Planned"}
                </span>
              </div>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.migrationNote}>
        <div>
          <p className={styles.eyebrow}>WORKSPACE MIGRATION</p>
          <h2>One system, not two competing meeting engines.</h2>
        </div>
        <p>
          This bridge deliberately points Workspace to the existing Tamishra
          Meet runtime first. The next migration step is to move that same
          LiveKit/API stack into the Workspace monorepo behind
          <code>@tamishra/meet-core</code>, while preserving meeting behavior
          and data compatibility.
        </p>
      </section>
    </main>
  );
}
