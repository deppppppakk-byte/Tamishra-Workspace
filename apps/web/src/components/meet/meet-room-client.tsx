"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LiveKitRoom,
  PreJoin,
  VideoConference
} from "@livekit/components-react";
import type { MeetingJoinContext } from "@tamishra/meet-core";
import {
  loadMeetingAccess,
  type MeetingAttendance,
  type MeetingAuditEvent,
  type MeetingBreakoutState,
  type MeetingCaptionStatus,
  type MeetingControls,
  type MeetingMessage,
  type MeetingParticipant,
  type MeetingNotes,
  type MeetingRecordingState,
  type MeetingSignal,
  type MeetingSummary,
  type MeetingTranscriptSegment,
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

type SidebarTab =
  | "chat"
  | "people"
  | "breakouts"
  | "notes"
  | "activity";

const initialControls: MeetingControls = {
  locked: false,
  chatEnabled: true,
  reactionsEnabled: true,
  handRaiseEnabled: true,
  participantMicrophoneEnabled: true,
  participantCameraEnabled: true,
  updatedAt: ""
};

const reactionOptions = ["👍", "👏", "🎉", "❤️"];

function auditLabel(event: MeetingAuditEvent) {
  const labels: Record<string, string> = {
    meeting_created: "Meeting created",
    meeting_started: "Meeting started",
    meeting_ended: "Meeting ended",
    join_requested: "Join requested",
    participant_admitted: "Participant admitted",
    participant_denied: "Participant denied",
    participant_removed: "Participant removed",
    controls_updated: "Meeting controls updated",
    hand_raise_cleared: "Hand raise cleared",
    cohost_promoted: "Co-host promoted",
    cohost_demoted: "Co-host removed",
    participant_microphone_muted: "Participant microphone muted",
    participant_camera_stopped: "Participant camera stopped",
    mute_all_mics: "All participant microphones muted",
    stop_all_cameras: "All participant cameras stopped",
    recording_started: "Recording started",
    recording_stopped: "Recording stopped",
    recording_consent_accepted: "Recording consent accepted",
    recording_consent_declined: "Recording consent declined",
    breakouts_published: "Breakout rooms opened",
    breakouts_returned: "Breakout rooms closed",
    captions_started: "Live captions started",
    captions_stopped: "Live captions stopped",
    meeting_notes_updated: "Meeting notes updated",
    meeting_summary_generated: "Meeting summary generated"
  };
  return labels[event.eventType] ?? event.eventType.replaceAll("_", " ");
}

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
  const [controls, setControls] = useState<MeetingControls>(initialControls);
  const [messages, setMessages] = useState<MeetingMessage[]>([]);
  const [signals, setSignals] = useState<MeetingSignal[]>([]);
  const [audit, setAudit] = useState<MeetingAuditEvent[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("chat");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [collaborationBusy, setCollaborationBusy] = useState(false);
  const [choices, setChoices] = useState<JoinChoices | null>(null);
  const [token, setToken] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");
  const [roomError, setRoomError] = useState("");
  const [copied, setCopied] = useState(false);
  const [connected, setConnected] = useState(false);
  const [recordingState, setRecordingState] =
    useState<MeetingRecordingState>({
      configured: false,
      active: null,
      consent: null,
      consents: [],
      recordings: []
    });
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [breakoutState, setBreakoutState] = useState<MeetingBreakoutState>({
    rooms: [],
    assignments: []
  });
  const [breakoutCount, setBreakoutCount] = useState(2);
  const [breakoutMinutes, setBreakoutMinutes] = useState(10);
  const [breakoutBusy, setBreakoutBusy] = useState(false);
  const [activeMediaRoom, setActiveMediaRoom] = useState("");
  const [activeBreakoutLabel, setActiveBreakoutLabel] = useState("");
  const [captionStatus, setCaptionStatus] =
    useState<MeetingCaptionStatus>({
      configured: false,
      state: {
        roomName: "",
        desiredState: "stopped",
        agentName: null,
        dispatchId: null,
        model: null,
        language: null,
        lastHeartbeatAt: null,
        lastError: null,
        updatedAt: ""
      }
    });
  const [captionsVisible, setCaptionsVisible] = useState(true);
  const [captionBusy, setCaptionBusy] = useState(false);
  const [transcript, setTranscript] =
    useState<MeetingTranscriptSegment[]>([]);
  const [notes, setNotes] = useState<MeetingNotes | null>(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [notesDirty, setNotesDirty] = useState(false);
  const [notesBusy, setNotesBusy] = useState(false);
  const [summary, setSummary] = useState<MeetingSummary | null>(null);
  const handoffRef = useRef(false);

  const isHost = context?.role === "host";
  const isModerator =
    context?.role === "host" || context?.role === "cohost";

  useEffect(() => {
    if (window.matchMedia("(max-width: 720px)").matches) {
      setSidebarOpen(false);
    }
  }, []);

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

  const loadCollaboration = useCallback(
    async (room: string, key: string) => {
      const result = await gateway.getCollaboration(room, key);
      setControls(result.controls);
      setMessages(result.messages);
      setSignals(result.signals);
      return result;
    },
    [gateway]
  );

  const loadAudit = useCallback(
    async (room: string, key: string) => {
      const result = await gateway.listAudit(room, key);
      setAudit(result);
    },
    [gateway]
  );

  const loadRecording = useCallback(
    async (room: string, key: string) => {
      const result = await gateway.getRecordingState(room, key);
      setRecordingState(result);
      return result;
    },
    [gateway]
  );

  const loadBreakouts = useCallback(
    async (room: string, key: string) => {
      const result = await gateway.getBreakouts(room, key);
      setBreakoutState(result);
      return result;
    },
    [gateway]
  );

  const loadCaptionStatus = useCallback(
    async (room: string, key: string) => {
      const result = await gateway.getCaptionStatus(room, key);
      setCaptionStatus(result);
      return result;
    },
    [gateway]
  );

  const loadTranscript = useCallback(
    async (room: string, key: string) => {
      const result = await gateway.getTranscript(room, key, 500);
      setTranscript(result);
      return result;
    },
    [gateway]
  );

  const loadNotes = useCallback(
    async (room: string, key: string) => {
      const result = await gateway.getNotes(room, key);
      setNotes(result);
      setNotesDraft(result.body);
      setNotesDirty(false);
      return result;
    },
    [gateway]
  );

  const loadSummary = useCallback(
    async (room: string, key: string) => {
      const result = await gateway.getSummary(room, key);
      setSummary(result);
      return result;
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
        const sharedLoads = [
          loadRecording(room, access.accessKey).catch(() => undefined),
          loadBreakouts(room, access.accessKey).catch(() => undefined),
          loadCaptionStatus(room, access.accessKey).catch(() => undefined),
          loadTranscript(room, access.accessKey).catch(() => undefined),
          loadNotes(room, access.accessKey).catch(() => undefined),
          loadSummary(room, access.accessKey).catch(() => undefined)
        ];

        if (result.role === "host" || result.role === "cohost") {
          setSidebarTab("people");
          return Promise.all([
            ...sharedLoads,
            loadParticipants(room, access.accessKey).catch(() => undefined),
            loadAttendance(room, access.accessKey).catch(() => undefined)
          ]);
        }

        return Promise.all(sharedLoads);
      })
      .catch((reason) => {
        setError(
          reason instanceof Error ? reason.message : "Unable to load meeting."
        );
      })
      .finally(() => setLoading(false));
  }, [
    loadAttendance,
    loadBreakouts,
    loadCaptionStatus,
    loadContext,
    loadNotes,
    loadParticipants,
    loadRecording,
    loadSummary,
    loadTranscript
  ]);

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
    if (!roomName || !accessKey || !isModerator) return;

    const refresh = () => {
      void loadParticipants(roomName, accessKey).catch(() => undefined);
      void loadAttendance(roomName, accessKey).catch(() => undefined);
      void loadAudit(roomName, accessKey).catch(() => undefined);
    };

    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [
    roomName,
    accessKey,
    isModerator,
    loadParticipants,
    loadAttendance,
    loadAudit
  ]);

  useEffect(() => {
    if (
      !roomName ||
      !accessKey ||
      !context ||
      context.status !== "live" ||
      context.admissionStatus !== "admitted"
    ) {
      return;
    }

    const refresh = () => {
      void loadCollaboration(roomName, accessKey).catch(() => undefined);
    };

    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, [
    roomName,
    accessKey,
    context,
    context?.status,
    context?.admissionStatus,
    loadCollaboration
  ]);

  useEffect(() => {
    if (
      !roomName ||
      !accessKey ||
      !context ||
      context.status !== "live" ||
      context.admissionStatus !== "admitted"
    ) {
      return;
    }

    const refresh = () => {
      void loadRecording(roomName, accessKey).catch(() => undefined);
    };

    refresh();
    const timer = window.setInterval(refresh, 2500);
    return () => window.clearInterval(timer);
  }, [
    roomName,
    accessKey,
    context,
    context?.status,
    context?.admissionStatus,
    loadRecording
  ]);

  useEffect(() => {
    if (
      !roomName ||
      !accessKey ||
      !context ||
      context.status !== "live" ||
      context.admissionStatus !== "admitted"
    ) {
      return;
    }

    const refresh = () => {
      void loadBreakouts(roomName, accessKey).catch(() => undefined);
      void loadCaptionStatus(roomName, accessKey)
        .then((status) => {
          if (status.state.desiredState === "running") {
            void loadTranscript(roomName, accessKey).catch(() => undefined);
          }
        })
        .catch(() => undefined);
    };

    refresh();
    const timer = window.setInterval(refresh, 2200);
    return () => window.clearInterval(timer);
  }, [
    roomName,
    accessKey,
    context,
    context?.status,
    context?.admissionStatus,
    loadBreakouts,
    loadCaptionStatus,
    loadTranscript
  ]);

  useEffect(() => {
    if (
      !roomName ||
      !accessKey ||
      !context ||
      context.role !== "participant" ||
      context.status !== "live" ||
      context.admissionStatus !== "admitted" ||
      !choices ||
      !token
    ) {
      return;
    }

    const assignment = breakoutState.assignments.find(
      (item) => item.participantId === context.participantId
    );
    const targetRoom = assignment?.livekitRoomName ?? roomName;

    if ((activeMediaRoom || roomName) === targetRoom) return;

    let cancelled = false;
    handoffRef.current = true;

    const handoff = assignment
      ? gateway.issueBreakoutToken(roomName, accessKey)
      : gateway.issueToken(roomName, accessKey, displayName);

    void handoff
      .then((result) => {
        if (cancelled) return;
        setServerUrl(result.url);
        setToken(result.token);
        setActiveMediaRoom(
          assignment
            ? (result as { mediaRoom: string }).mediaRoom
            : roomName
        );
        setActiveBreakoutLabel(
          assignment
            ? (result as { groupLabel: string }).groupLabel
            : ""
        );
        setRoomError(
          assignment
            ? "Joined " +
                (result as { groupLabel: string }).groupLabel +
                "."
            : "Returned to the main meeting."
        );
      })
      .catch((reason) => {
        handoffRef.current = false;
        if (cancelled) return;
        setRoomError(
          reason instanceof Error
            ? reason.message
            : "Unable to switch meeting room."
        );
      });

    return () => {
      cancelled = true;
    };
  }, [
    roomName,
    accessKey,
    context,
    choices,
    token,
    activeMediaRoom,
    breakoutState.assignments,
    displayName,
    gateway
  ]);

  useEffect(() => {
    if (!roomName || !accessKey || !connected) return;

    const refresh = () => {
      void loadContext(roomName, accessKey).catch(() => undefined);
    };

    const timer = window.setInterval(refresh, 4000);
    return () => window.clearInterval(timer);
  }, [roomName, accessKey, connected, loadContext]);

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

  async function sendChat() {
    const message = chatDraft.trim();
    if (!roomName || !accessKey || !message || collaborationBusy) return;
    setCollaborationBusy(true);
    try {
      const result = await gateway.sendMessage(roomName, accessKey, message);
      setMessages((current) => [...current, result.message]);
      setChatDraft("");
    } catch (reason) {
      setRoomError(
        reason instanceof Error ? reason.message : "Unable to send message."
      );
    } finally {
      setCollaborationBusy(false);
    }
  }

  async function toggleHandRaise() {
    if (!roomName || !accessKey || collaborationBusy) return;
    const ownSignal = signals.find(
      (signal) => signal.participantId === context?.participantId
    );
    const nextRaised = !ownSignal?.handRaised;
    setCollaborationBusy(true);
    try {
      await gateway.setSignal(roomName, accessKey, {
        handRaised: nextRaised,
        reaction: null
      });
      await loadCollaboration(roomName, accessKey);
    } catch (reason) {
      setRoomError(
        reason instanceof Error ? reason.message : "Unable to update hand raise."
      );
    } finally {
      setCollaborationBusy(false);
    }
  }

  async function sendReaction(reaction: string) {
    if (!roomName || !accessKey || collaborationBusy) return;
    const ownSignal = signals.find(
      (signal) => signal.participantId === context?.participantId
    );
    setCollaborationBusy(true);
    try {
      await gateway.setSignal(roomName, accessKey, {
        handRaised: Boolean(ownSignal?.handRaised),
        reaction
      });
      await loadCollaboration(roomName, accessKey);
    } catch (reason) {
      setRoomError(
        reason instanceof Error ? reason.message : "Unable to send reaction."
      );
    } finally {
      setCollaborationBusy(false);
    }
  }

  async function updateHostControls(
    patch: Partial<Pick<
      MeetingControls,
      | "locked"
      | "chatEnabled"
      | "reactionsEnabled"
      | "handRaiseEnabled"
      | "participantMicrophoneEnabled"
      | "participantCameraEnabled"
    >>
  ) {
    if (!roomName || !accessKey || !isHost || collaborationBusy) return;
    setCollaborationBusy(true);
    try {
      const result = await gateway.updateControls(roomName, accessKey, patch);
      setControls(result.controls);
      await loadAudit(roomName, accessKey);
    } catch (reason) {
      setRoomError(
        reason instanceof Error ? reason.message : "Unable to update controls."
      );
    } finally {
      setCollaborationBusy(false);
    }
  }

  async function moderateParticipant(
    participantId: string,
    action: "remove" | "clear-hand"
  ) {
    if (!roomName || !accessKey || !isModerator || collaborationBusy) return;
    setCollaborationBusy(true);
    try {
      await gateway.moderate(roomName, accessKey, participantId, action);
      await Promise.all([
        loadParticipants(roomName, accessKey),
        loadAttendance(roomName, accessKey),
        loadCollaboration(roomName, accessKey),
        loadAudit(roomName, accessKey)
      ]);
    } catch (reason) {
      setRoomError(
        reason instanceof Error ? reason.message : "Unable to moderate participant."
      );
    } finally {
      setCollaborationBusy(false);
    }
  }

  async function updateParticipantRole(
    participantId: string,
    role: "cohost" | "participant"
  ) {
    if (!roomName || !accessKey || !isHost || collaborationBusy) return;
    setCollaborationBusy(true);
    try {
      await gateway.setRole(roomName, accessKey, participantId, role);
      await Promise.all([
        loadParticipants(roomName, accessKey),
        loadAudit(roomName, accessKey)
      ]);
    } catch (reason) {
      setRoomError(
        reason instanceof Error ? reason.message : "Unable to update meeting role."
      );
    } finally {
      setCollaborationBusy(false);
    }
  }

  async function controlParticipantMedia(
    participantId: string,
    action: "mute-mic" | "stop-camera"
  ) {
    if (!roomName || !accessKey || !isModerator || collaborationBusy) return;
    setCollaborationBusy(true);
    try {
      await gateway.controlMedia(
        roomName,
        accessKey,
        action,
        participantId
      );
      await Promise.all([
        loadParticipants(roomName, accessKey),
        loadAudit(roomName, accessKey)
      ]);
    } catch (reason) {
      setRoomError(
        reason instanceof Error ? reason.message : "Unable to control participant media."
      );
    } finally {
      setCollaborationBusy(false);
    }
  }

  async function controlAllMedia(
    action: "mute-all-mics" | "stop-all-cameras"
  ) {
    if (!roomName || !accessKey || !isModerator || collaborationBusy) return;
    setCollaborationBusy(true);
    try {
      await gateway.controlMedia(roomName, accessKey, action);
      await Promise.all([
        loadParticipants(roomName, accessKey),
        loadAudit(roomName, accessKey)
      ]);
    } catch (reason) {
      setRoomError(
        reason instanceof Error ? reason.message : "Unable to control room media."
      );
    } finally {
      setCollaborationBusy(false);
    }
  }

  async function setRecordingConsent(
    consent: "accepted" | "declined"
  ) {
    if (!roomName || !accessKey || recordingBusy) return;
    setRecordingBusy(true);
    setRoomError("");
    setError("");
    try {
      await gateway.setRecordingConsent(roomName, accessKey, consent);
      await Promise.all([
        loadRecording(roomName, accessKey),
        isModerator
          ? loadAudit(roomName, accessKey)
          : Promise.resolve()
      ]);
    } catch (reason) {
      const message =
        reason instanceof Error
          ? reason.message
          : "Unable to update recording consent.";
      setRoomError(message);
      setError(message);
    } finally {
      setRecordingBusy(false);
    }
  }

  async function controlRecording(action: "start" | "stop") {
    if (!roomName || !accessKey || !isHost || recordingBusy) return;
    setRecordingBusy(true);
    setRoomError("");
    try {
      await gateway.controlRecording(roomName, accessKey, action);
      await Promise.all([
        loadRecording(roomName, accessKey),
        loadAudit(roomName, accessKey)
      ]);
    } catch (reason) {
      const body = (reason as {
        body?: {
          pending?: Array<{ displayName?: string }>;
          declined?: Array<{ displayName?: string }>;
        };
      }).body;
      const pendingNames = body?.pending
        ?.map((item) => item.displayName)
        .filter(Boolean)
        .join(", ");
      setRoomError(
        pendingNames
          ? "Recording is waiting for consent from: " + pendingNames
          : reason instanceof Error
            ? reason.message
            : "Unable to control recording."
      );
    } finally {
      setRecordingBusy(false);
    }
  }

  async function startBreakouts() {
    if (!roomName || !accessKey || !isModerator || breakoutBusy) return;

    const candidates = participants.filter(
      (participant) =>
        participant.role === "participant" &&
        participant.admissionStatus === "admitted"
    );

    if (candidates.length === 0) {
      setRoomError("Admit participants before opening breakout rooms.");
      return;
    }

    const roomCount = Math.max(
      1,
      Math.min(Math.round(breakoutCount), Math.min(20, candidates.length))
    );

    const assignments = candidates.map((participant, index) => {
      const groupNumber = (index % roomCount) + 1;
      return {
        participantId: participant.id,
        groupId: "group-" + groupNumber,
        groupLabel: "Breakout " + groupNumber
      };
    });

    setBreakoutBusy(true);
    setRoomError("");
    try {
      await gateway.publishBreakouts(
        roomName,
        accessKey,
        assignments,
        breakoutMinutes
      );
      await Promise.all([
        loadBreakouts(roomName, accessKey),
        loadAudit(roomName, accessKey)
      ]);
    } catch (reason) {
      setRoomError(
        reason instanceof Error
          ? reason.message
          : "Unable to open breakout rooms."
      );
    } finally {
      setBreakoutBusy(false);
    }
  }

  async function returnAllBreakouts() {
    if (!roomName || !accessKey || !isModerator || breakoutBusy) return;
    setBreakoutBusy(true);
    setRoomError("");
    try {
      await gateway.returnAllBreakouts(roomName, accessKey);
      await Promise.all([
        loadBreakouts(roomName, accessKey),
        loadAudit(roomName, accessKey)
      ]);
    } catch (reason) {
      setRoomError(
        reason instanceof Error
          ? reason.message
          : "Unable to close breakout rooms."
      );
    } finally {
      setBreakoutBusy(false);
    }
  }

  async function controlCaptions(action: "start" | "stop") {
    if (!roomName || !accessKey || !isModerator || captionBusy) return;
    setCaptionBusy(true);
    setRoomError("");
    try {
      const status = await gateway.controlCaptions(
        roomName,
        accessKey,
        action
      );
      setCaptionStatus(status);
      if (action === "start") {
        setCaptionsVisible(true);
      }
      await loadAudit(roomName, accessKey);
    } catch (reason) {
      setRoomError(
        reason instanceof Error
          ? reason.message
          : "Unable to control live captions."
      );
    } finally {
      setCaptionBusy(false);
    }
  }

  async function saveSharedNotes() {
    if (!roomName || !accessKey || !isModerator || notesBusy) return;
    setNotesBusy(true);
    setRoomError("");
    try {
      const result = await gateway.saveNotes(
        roomName,
        accessKey,
        notesDraft
      );
      setNotes(result);
      setNotesDirty(false);
      await loadAudit(roomName, accessKey);
    } catch (reason) {
      setRoomError(
        reason instanceof Error
          ? reason.message
          : "Unable to save meeting notes."
      );
    } finally {
      setNotesBusy(false);
    }
  }

  async function generateSummary() {
    if (!roomName || !accessKey || !isModerator || notesBusy) return;
    setNotesBusy(true);
    setRoomError("");
    try {
      const result = await gateway.generateSummary(roomName, accessKey);
      setSummary(result);
      await loadAudit(roomName, accessKey);
    } catch (reason) {
      setRoomError(
        reason instanceof Error
          ? reason.message
          : "Unable to generate meeting summary."
      );
    } finally {
      setNotesBusy(false);
    }
  }

  async function connect(values: JoinChoices) {
    if (!roomName || !accessKey || joining) return;
    setJoining(true);
    setError("");
    try {
      if (
        recordingState.active &&
        !isHost &&
        recordingState.consent?.consent !== "accepted"
      ) {
        setError("Accept recording consent before joining this recorded meeting.");
        return;
      }

      const result = await gateway.issueToken(
        roomName,
        accessKey,
        values.username?.trim() || displayName
      );
      setChoices({
        ...values,
        audioEnabled:
          values.audioEnabled &&
          (result.role !== "participant" ||
            result.participantMicrophoneEnabled),
        videoEnabled:
          values.videoEnabled &&
          (result.role !== "participant" ||
            result.participantCameraEnabled)
      });
      setToken(result.token);
      setServerUrl(result.url);
      setActiveMediaRoom(roomName);
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
            {recordingState.active && (
            <span className={styles.recordingBadge}>
              <span />
              REC
            </span>
          )}
          {isHost && hostJoinCode && (
              <button className={styles.codeButton} onClick={() => void copyJoinCode()}>
                <span>{copied ? "Copied" : "Private code"}</span>
                <strong>{hostJoinCode}</strong>
              </button>
            )}
            <span className={styles.roleBadge}>
              {context.role === "host"
                ? "Host"
                : context.role === "cohost"
                  ? "Co-host"
                  : "Participant"}
            </span>
          </div>
        </header>

        {error && <div className={styles.prejoinError}>{error}</div>}

        {!isHost && (
          <div className={styles.recordingConsentCard}>
            <div>
              <span>RECORDING CONSENT</span>
              <strong>
                {recordingState.active
                  ? "This meeting is currently being recorded."
                  : "Set your recording preference before the host records."}
              </strong>
              <small>
                You can withdraw consent later. If recording is active,
                withdrawing consent stops the recording.
              </small>
            </div>
            <div>
              <button
                className={
                  recordingState.consent?.consent === "accepted"
                    ? styles.consentAccepted
                    : styles.consentButton
                }
                disabled={recordingBusy}
                onClick={() => void setRecordingConsent("accepted")}
              >
                {recordingState.consent?.consent === "accepted"
                  ? "Recording allowed"
                  : "Allow recording"}
              </button>
              <button
                className={
                  recordingState.consent?.consent === "declined"
                    ? styles.consentDeclined
                    : styles.consentButton
                }
                disabled={recordingBusy}
                onClick={() => void setRecordingConsent("declined")}
              >
                Decline
              </button>
            </div>
          </div>
        )}

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
  const admittedParticipants = participants.filter(
    (participant) =>
      participant.role !== "host" &&
      participant.admissionStatus === "admitted"
  );
  const manageableParticipants = admittedParticipants.filter(
    (participant) =>
      participant.id !== context.participantId &&
      (isHost || participant.role === "participant")
  );
  const raisedSignals = signals.filter((signal) => signal.handRaised);
  const reactionSignals = signals.filter((signal) => signal.reaction);
  const ownSignal = signals.find(
    (signal) => signal.participantId === context.participantId
  );
  const latestCaption =
    [...transcript]
      .reverse()
      .find((segment) => segment.text.trim()) ?? null;
  const ownBreakoutAssignment = breakoutState.assignments.find(
    (assignment) => assignment.participantId === context.participantId
  );

  return (
    <LiveKitRoom
      key={activeMediaRoom || roomName}
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
        handoffRef.current = false;
        setConnected(true);
        setRoomError("");
      }}
      onDisconnected={() => {
        setConnected(false);
        if (handoffRef.current) return;
        void loadContext(roomName, accessKey)
          .then((next) => {
            setRoomError(
              next.admissionStatus === "denied"
                ? "You were removed from this meeting by the host."
                : "Meeting connection ended."
            );
          })
          .catch(() => setRoomError("Meeting connection ended."));
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
            <small>
              {activeBreakoutLabel
                ? activeBreakoutLabel + " · " + roomName
                : roomName}
            </small>
          </div>
        </div>
        <div className={styles.liveHeaderActions}>
          {activeBreakoutLabel && (
            <span className={styles.breakoutBadge}>
              {activeBreakoutLabel}
            </span>
          )}
          {isHost && hostJoinCode && (
            <button className={styles.compactCode} onClick={() => void copyJoinCode()}>
              {copied ? "Copied" : hostJoinCode}
            </button>
          )}
          {isHost && (
            <button
              className={
                recordingState.active
                  ? styles.stopRecordingButton
                  : styles.recordingButton
              }
              disabled={
                recordingBusy ||
                (!recordingState.active && !recordingState.configured)
              }
              onClick={() =>
                void controlRecording(
                  recordingState.active ? "stop" : "start"
                )
              }
              title={
                recordingState.configured
                  ? undefined
                  : "Configure Workspace recording storage first."
              }
            >
              {recordingBusy
                ? "Recording…"
                : recordingState.active
                  ? "Stop recording"
                  : "Start recording"}
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

      <div
        className={roomError ? styles.roomError : styles.roomErrorPlaceholder}
        role="status"
      >
        {roomError}
      </div>

      <div className={styles.liveLayout}>
        <section className={styles.conference}>
          <div className={styles.collaborationToolbar}>
            <button
              className={
                ownSignal?.handRaised
                  ? styles.toolbarButtonActive
                  : styles.toolbarButton
              }
              disabled={!controls.handRaiseEnabled || collaborationBusy}
              onClick={() => void toggleHandRaise()}
            >
              ✋ {ownSignal?.handRaised ? "Lower hand" : "Raise hand"}
            </button>

            <div className={styles.reactionButtons}>
              {reactionOptions.map((reaction) => (
                <button
                  key={reaction}
                  disabled={!controls.reactionsEnabled || collaborationBusy}
                  onClick={() => void sendReaction(reaction)}
                  title={"React " + reaction}
                >
                  {reaction}
                </button>
              ))}
            </div>

            <button
              className={styles.toolbarButton}
              onClick={() => {
                setSidebarTab("chat");
                setSidebarOpen(true);
              }}
            >
              Chat {messages.length > 0 ? "· " + messages.length : ""}
            </button>

            {isModerator && (
              <button
                className={styles.toolbarButton}
                onClick={() => {
                  setSidebarTab("people");
                  setSidebarOpen(true);
                }}
              >
                People · {participants.length}
              </button>
            )}

            <button
              className={
                captionsVisible &&
                captionStatus.state.desiredState === "running"
                  ? styles.toolbarButtonActive
                  : styles.toolbarButton
              }
              onClick={() => setCaptionsVisible((value) => !value)}
              title={
                captionStatus.state.desiredState === "running"
                  ? "Show or hide live captions"
                  : "Live captions are not running"
              }
            >
              CC
              {captionStatus.state.desiredState === "running"
                ? " · Live"
                : ""}
            </button>

            <button
              className={styles.toolbarButton}
              onClick={() => {
                setSidebarTab("notes");
                setSidebarOpen(true);
              }}
            >
              Notes
            </button>

            {isModerator && (
              <button
                className={
                  breakoutState.rooms.length > 0
                    ? styles.toolbarButtonActive
                    : styles.toolbarButton
                }
                onClick={() => {
                  setSidebarTab("breakouts");
                  setSidebarOpen(true);
                }}
              >
                Breakouts
                {breakoutState.rooms.length > 0
                  ? " · " + breakoutState.rooms.length
                  : ""}
              </button>
            )}

            {!isHost && (
              <button
                className={
                  recordingState.consent?.consent === "accepted"
                    ? styles.toolbarConsentAccepted
                    : recordingState.consent?.consent === "declined"
                      ? styles.toolbarConsentDeclined
                      : styles.toolbarButton
                }
                disabled={recordingBusy}
                onClick={() =>
                  void setRecordingConsent(
                    recordingState.consent?.consent === "accepted"
                      ? "declined"
                      : "accepted"
                  )
                }
              >
                {recordingState.consent?.consent === "accepted"
                  ? "Recording allowed"
                  : recordingState.consent?.consent === "declined"
                    ? "Recording declined"
                    : "Allow recording"}
              </button>
            )}

            {raisedSignals.length > 0 && (
              <span className={styles.raiseSummary}>
                ✋ {raisedSignals.length} raised
              </span>
            )}
          </div>

          <div className={styles.conferenceStage}>
            <VideoConference />
            {captionsVisible &&
              captionStatus.state.desiredState === "running" &&
              latestCaption && (
                <div
                  className={styles.captionOverlay}
                  aria-live="polite"
                >
                  <strong>
                    {latestCaption.participantName ||
                      latestCaption.participantIdentity}
                  </strong>
                  <span>{latestCaption.text}</span>
                </div>
              )}
            {reactionSignals.length > 0 && (
              <div className={styles.reactionOverlay} aria-live="polite">
                {reactionSignals.slice(0, 5).map((signal) => (
                  <span key={signal.participantId + signal.updatedAt}>
                    <strong>{signal.reaction}</strong>
                    <small>{signal.displayName}</small>
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>

        <aside
          className={
            sidebarOpen
              ? styles.hostPanel
              : styles.hostPanelHidden
          }
        >
          <div className={styles.sidebarTabs}>
            <button
              className={sidebarTab === "chat" ? styles.sidebarTabActive : ""}
              onClick={() => setSidebarTab("chat")}
            >
              Chat
            </button>
            <button
              className={sidebarTab === "people" ? styles.sidebarTabActive : ""}
              onClick={() => setSidebarTab("people")}
            >
              {isModerator ? "People" : "Signals"}
            </button>
            <button
              className={sidebarTab === "notes" ? styles.sidebarTabActive : ""}
              onClick={() => setSidebarTab("notes")}
            >
              Notes
            </button>
            {isModerator && (
              <button
                className={
                  sidebarTab === "breakouts"
                    ? styles.sidebarTabActive
                    : ""
                }
                onClick={() => setSidebarTab("breakouts")}
              >
                Breakouts
              </button>
            )}
            {isModerator && (
              <button
                className={sidebarTab === "activity" ? styles.sidebarTabActive : ""}
                onClick={() => setSidebarTab("activity")}
              >
                Activity
              </button>
            )}
            <button
              className={styles.sidebarClose}
              aria-label="Close meeting sidebar"
              onClick={() => setSidebarOpen(false)}
            >
              ×
            </button>
          </div>

          {sidebarTab === "chat" && (
            <div className={styles.chatPanel}>
              <div className={styles.hostPanelHeading}>
                <span>MEETING CHAT</span>
                <strong>
                  {controls.chatEnabled ? "Conversation" : "Chat paused by host"}
                </strong>
              </div>

              <div className={styles.messageList}>
                {messages.length === 0 && (
                  <p className={styles.emptyState}>No messages yet.</p>
                )}
                {messages.map((message) => (
                  <article
                    className={
                      message.participantId === context.participantId
                        ? styles.ownMessage
                        : styles.message
                    }
                    key={message.id}
                  >
                    <div>
                      <strong>{message.displayName}</strong>
                      <time>
                        {new Intl.DateTimeFormat(undefined, {
                          hour: "numeric",
                          minute: "2-digit"
                        }).format(new Date(message.createdAt))}
                      </time>
                    </div>
                    <p>{message.body}</p>
                  </article>
                ))}
              </div>

              <form
                className={styles.chatComposer}
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendChat();
                }}
              >
                <input
                  value={chatDraft}
                  onChange={(event) => setChatDraft(event.target.value)}
                  placeholder={
                    controls.chatEnabled
                      ? "Message everyone"
                      : "Chat is disabled"
                  }
                  disabled={!controls.chatEnabled}
                  maxLength={2000}
                />
                <button
                  disabled={
                    !controls.chatEnabled ||
                    !chatDraft.trim() ||
                    collaborationBusy
                  }
                >
                  Send
                </button>
              </form>
            </div>
          )}

          {sidebarTab === "people" && (
            <div className={styles.peoplePanel}>
              {isModerator && (
                <div className={styles.recordingPanel}>
                  <div className={styles.recordingPanelHeader}>
                    <div>
                      <span className={styles.groupLabel}>RECORDING</span>
                      <strong>
                        {recordingState.active
                          ? "Recording in progress"
                          : recordingState.configured
                            ? "Ready to record"
                            : "Storage not configured"}
                      </strong>
                    </div>
                    {recordingState.active && (
                      <span className={styles.recordingBadge}>
                        <span />
                        REC
                      </span>
                    )}
                  </div>

                  <small>
                    {recordingState.consents.filter(
                      (item) => item.consent === "accepted"
                    ).length}
                    {" accepted · "}
                    {recordingState.consents.filter(
                      (item) => item.consent === "declined"
                    ).length}
                    {" declined"}
                  </small>

                  {isHost && (
                    <button
                      className={
                        recordingState.active
                          ? styles.stopRecordingInline
                          : styles.startRecordingInline
                      }
                      disabled={
                        recordingBusy ||
                        (!recordingState.active &&
                          !recordingState.configured)
                      }
                      onClick={() =>
                        void controlRecording(
                          recordingState.active ? "stop" : "start"
                        )
                      }
                    >
                      {recordingState.active
                        ? "Stop recording"
                        : "Start recording"}
                    </button>
                  )}
                </div>
              )}

              {isHost && (
                <div className={styles.policyPanel}>
                  <span className={styles.groupLabel}>ROOM POLICIES</span>
                  <label>
                    <input
                      type="checkbox"
                      checked={controls.locked}
                      onChange={(event) =>
                        void updateHostControls({ locked: event.target.checked })
                      }
                    />
                    <span>
                      <strong>Lock new joins</strong>
                      <small>Blocks new code-based join attempts.</small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={controls.chatEnabled}
                      onChange={(event) =>
                        void updateHostControls({
                          chatEnabled: event.target.checked
                        })
                      }
                    />
                    <span>
                      <strong>Meeting chat</strong>
                      <small>Allow participants to send persistent messages.</small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={controls.reactionsEnabled}
                      onChange={(event) =>
                        void updateHostControls({
                          reactionsEnabled: event.target.checked
                        })
                      }
                    />
                    <span>
                      <strong>Reactions</strong>
                      <small>Allow transient live reactions.</small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={controls.handRaiseEnabled}
                      onChange={(event) =>
                        void updateHostControls({
                          handRaiseEnabled: event.target.checked
                        })
                      }
                    />
                    <span>
                      <strong>Hand raise</strong>
                      <small>Allow persistent hand-raise signals.</small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={controls.participantMicrophoneEnabled}
                      onChange={(event) =>
                        void updateHostControls({
                          participantMicrophoneEnabled: event.target.checked
                        })
                      }
                    />
                    <span>
                      <strong>Participant microphones</strong>
                      <small>
                        Allow participants to publish microphone audio.
                      </small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={controls.participantCameraEnabled}
                      onChange={(event) =>
                        void updateHostControls({
                          participantCameraEnabled: event.target.checked
                        })
                      }
                    />
                    <span>
                      <strong>Participant cameras</strong>
                      <small>
                        Allow participants to publish camera video.
                      </small>
                    </span>
                  </label>
                </div>
              )}

              {raisedSignals.length > 0 && (
                <div className={styles.waitingGroup}>
                  <span className={styles.groupLabel}>
                    RAISED HANDS · {raisedSignals.length}
                  </span>
                  {raisedSignals.map((signal) => (
                    <article className={styles.participantCard} key={signal.participantId}>
                      <div>
                        <strong>✋ {signal.displayName}</strong>
                        <small>Waiting to speak</small>
                      </div>
                      {isModerator &&
                        signal.participantId !== context.participantId && (
                          <div>
                            <button
                              className={styles.denyButton}
                              onClick={() =>
                                void moderateParticipant(
                                  signal.participantId,
                                  "clear-hand"
                                )
                              }
                            >
                              Clear
                            </button>
                          </div>
                        )}
                    </article>
                  ))}
                </div>
              )}

              {isModerator && waitingParticipants.length > 0 && (
                <div className={styles.waitingGroup}>
                  <span className={styles.groupLabel}>
                    WAITING · {waitingParticipants.length}
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

              {isModerator && (
                <div className={styles.allParticipants}>
                  <div className={styles.participantSectionHeader}>
                    <span className={styles.groupLabel}>
                      IN ROOM · {admittedParticipants.length}
                    </span>
                    <div>
                      <button
                        disabled={collaborationBusy}
                        onClick={() => void controlAllMedia("mute-all-mics")}
                      >
                        Mute all
                      </button>
                      <button
                        disabled={collaborationBusy}
                        onClick={() => void controlAllMedia("stop-all-cameras")}
                      >
                        Stop cameras
                      </button>
                    </div>
                  </div>

                  {manageableParticipants.map((participant) => (
                    <div className={styles.participantControlRow} key={participant.id}>
                      <span className={styles.participantAvatar}>
                        {participant.displayName
                          .split(" ")
                          .slice(0, 2)
                          .map((part) => part[0])
                          .join("")
                          .toUpperCase()}
                      </span>
                      <div className={styles.participantIdentity}>
                        <strong>
                          {participant.displayName}
                          {participant.role === "cohost" && (
                            <span className={styles.cohostBadge}>Co-host</span>
                          )}
                        </strong>
                        <small>
                          {participant.microphoneActive ? "Mic on" : "Mic off"}
                          {" · "}
                          {participant.cameraActive ? "Camera on" : "Camera off"}
                          {participant.screenShareActive ? " · Sharing" : ""}
                        </small>
                      </div>
                      <div className={styles.participantActions}>
                        {participant.microphoneActive && (
                          <button
                            disabled={collaborationBusy}
                            onClick={() =>
                              void controlParticipantMedia(
                                participant.id,
                                "mute-mic"
                              )
                            }
                          >
                            Mute
                          </button>
                        )}
                        {participant.cameraActive && (
                          <button
                            disabled={collaborationBusy}
                            onClick={() =>
                              void controlParticipantMedia(
                                participant.id,
                                "stop-camera"
                              )
                            }
                          >
                            Stop camera
                          </button>
                        )}
                        {isHost && (
                          <button
                            disabled={collaborationBusy}
                            onClick={() =>
                              void updateParticipantRole(
                                participant.id,
                                participant.role === "cohost"
                                  ? "participant"
                                  : "cohost"
                              )
                            }
                          >
                            {participant.role === "cohost"
                              ? "Remove co-host"
                              : "Make co-host"}
                          </button>
                        )}
                        <button
                          className={styles.removeButton}
                          disabled={collaborationBusy}
                          onClick={() =>
                            void moderateParticipant(participant.id, "remove")
                          }
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {isModerator && (
                <div className={styles.attendanceGroup}>
                  <span className={styles.groupLabel}>
                    ATTENDANCE · {attendance.length}
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
              )}

              {!isModerator && ownBreakoutAssignment && (
                <div className={styles.breakoutParticipantCard}>
                  <span className={styles.groupLabel}>BREAKOUT</span>
                  <strong>
                    {activeBreakoutLabel ||
                      ownBreakoutAssignment.groupId}
                  </strong>
                  <small>
                    You will return to the main room automatically when
                    the host closes the breakout session.
                  </small>
                </div>
              )}

              {!isModerator &&
                !ownBreakoutAssignment &&
                raisedSignals.length === 0 && (
                  <p className={styles.emptyState}>
                    No active hand raises right now.
                  </p>
                )}
            </div>
          )}

          {sidebarTab === "notes" && (
            <div className={styles.notesPanel}>
              <div className={styles.hostPanelHeading}>
                <span>MEETING INTELLIGENCE</span>
                <strong>Notes, captions & summary</strong>
              </div>

              <div className={styles.captionControlCard}>
                <div>
                  <span className={styles.groupLabel}>LIVE CAPTIONS</span>
                  <strong>
                    {captionStatus.state.desiredState === "running"
                      ? "Caption agent is running"
                      : captionStatus.configured
                        ? "Caption agent is ready"
                        : "Caption worker not configured"}
                  </strong>
                  <small>
                    {captionStatus.state.lastHeartbeatAt
                      ? "Last transcript heartbeat " +
                        new Intl.DateTimeFormat(undefined, {
                          hour: "numeric",
                          minute: "2-digit"
                        }).format(
                          new Date(
                            captionStatus.state.lastHeartbeatAt
                          )
                        )
                      : "Transcript segments will appear below when available."}
                  </small>
                </div>

                {isModerator && (
                  <button
                    disabled={
                      captionBusy ||
                      (!captionStatus.configured &&
                        captionStatus.state.desiredState !== "running")
                    }
                    onClick={() =>
                      void controlCaptions(
                        captionStatus.state.desiredState === "running"
                          ? "stop"
                          : "start"
                      )
                    }
                  >
                    {captionBusy
                      ? "Updating…"
                      : captionStatus.state.desiredState === "running"
                        ? "Stop captions"
                        : "Start captions"}
                  </button>
                )}
              </div>

              <div className={styles.notesEditorCard}>
                <div className={styles.notesCardHeader}>
                  <div>
                    <span className={styles.groupLabel}>SHARED NOTES</span>
                    <strong>
                      {isModerator
                        ? "Host & co-host notes"
                        : "Meeting notes"}
                    </strong>
                  </div>
                  {notes?.updatedByDisplayName && (
                    <small>
                      Updated by {notes.updatedByDisplayName}
                    </small>
                  )}
                </div>

                <textarea
                  value={notesDraft}
                  readOnly={!isModerator}
                  maxLength={50000}
                  onChange={(event) => {
                    setNotesDraft(event.target.value);
                    setNotesDirty(true);
                  }}
                  placeholder={
                    isModerator
                      ? "Capture decisions, context and follow-up notes…"
                      : "No shared notes yet."
                  }
                />

                {isModerator && (
                  <button
                    disabled={!notesDirty || notesBusy}
                    onClick={() => void saveSharedNotes()}
                  >
                    {notesBusy ? "Saving…" : "Save notes"}
                  </button>
                )}
              </div>

              <div className={styles.summaryCard}>
                <div className={styles.notesCardHeader}>
                  <div>
                    <span className={styles.groupLabel}>SUMMARY</span>
                    <strong>
                      {summary
                        ? "Latest meeting summary"
                        : "No summary generated yet"}
                    </strong>
                  </div>
                  {isModerator && (
                    <button
                      disabled={notesBusy}
                      onClick={() => void generateSummary()}
                    >
                      {notesBusy
                        ? "Generating…"
                        : summary
                          ? "Regenerate"
                          : "Generate summary"}
                    </button>
                  )}
                </div>

                {summary ? (
                  <>
                    <p>{summary.summary}</p>
                    {summary.actionItems.length > 0 && (
                      <div className={styles.actionItems}>
                        <span className={styles.groupLabel}>
                          ACTION ITEMS
                        </span>
                        {summary.actionItems.map((item, index) => (
                          <div key={index}>
                            <span>{index + 1}</span>
                            <p>{item}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    <small>
                      Generated by {summary.provider}
                    </small>
                  </>
                ) : (
                  <p className={styles.emptyState}>
                    Generate a summary from finalized transcript
                    segments and shared notes.
                  </p>
                )}
              </div>

              <div className={styles.transcriptPanel}>
                <div className={styles.notesCardHeader}>
                  <div>
                    <span className={styles.groupLabel}>TRANSCRIPT</span>
                    <strong>
                      {transcript.length} segments
                    </strong>
                  </div>
                  <button
                    onClick={() =>
                      void loadTranscript(roomName, accessKey)
                    }
                  >
                    Refresh
                  </button>
                </div>

                {transcript.length === 0 ? (
                  <p className={styles.emptyState}>
                    No transcript segments have been received yet.
                  </p>
                ) : (
                  <div className={styles.transcriptList}>
                    {transcript.slice(-80).map((segment) => (
                      <article key={segment.segmentId}>
                        <div>
                          <strong>
                            {segment.participantName ||
                              segment.participantIdentity}
                          </strong>
                          <span>
                            {segment.isFinal ? "Final" : "Live"}
                          </span>
                        </div>
                        <p>{segment.text}</p>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {isModerator && sidebarTab === "breakouts" && (
            <div className={styles.breakoutPanel}>
              <div className={styles.hostPanelHeading}>
                <span>BREAKOUT ROOMS</span>
                <strong>Small-group sessions</strong>
              </div>

              {breakoutState.rooms.length === 0 ? (
                <div className={styles.breakoutSetup}>
                  <label>
                    Rooms
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={breakoutCount}
                      onChange={(event) =>
                        setBreakoutCount(
                          Math.max(
                            1,
                            Math.min(20, Number(event.target.value) || 1)
                          )
                        )
                      }
                    />
                  </label>
                  <label>
                    Minutes
                    <input
                      type="number"
                      min={1}
                      max={120}
                      value={breakoutMinutes}
                      onChange={(event) =>
                        setBreakoutMinutes(
                          Math.max(
                            1,
                            Math.min(120, Number(event.target.value) || 1)
                          )
                        )
                      }
                    />
                  </label>
                  <button
                    disabled={breakoutBusy}
                    onClick={() => void startBreakouts()}
                  >
                    {breakoutBusy
                      ? "Opening…"
                      : "Auto-assign & open"}
                  </button>
                  <small>
                    Admitted participants are distributed round-robin.
                    Hosts and co-hosts remain in the main room.
                  </small>
                </div>
              ) : (
                <>
                  <div className={styles.breakoutLiveHeader}>
                    <div>
                      <span className={styles.liveDot} />
                      <strong>
                        {breakoutState.rooms.length} rooms open
                      </strong>
                    </div>
                    <button
                      disabled={breakoutBusy}
                      onClick={() => void returnAllBreakouts()}
                    >
                      {breakoutBusy ? "Closing…" : "Return everyone"}
                    </button>
                  </div>

                  <div className={styles.breakoutRoomList}>
                    {breakoutState.rooms.map((room) => {
                      const assigned =
                        breakoutState.assignments.filter(
                          (item) => item.groupId === room.groupId
                        );
                      return (
                        <article key={room.groupId}>
                          <div>
                            <strong>{room.groupLabel}</strong>
                            <small>
                              {room.durationMinutes
                                ? room.durationMinutes + " min"
                                : "No timer"}
                            </small>
                          </div>
                          <div className={styles.breakoutMembers}>
                            {assigned.map((item) => (
                              <span key={item.participantId}>
                                {item.displayName}
                              </span>
                            ))}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {isModerator && sidebarTab === "activity" && (
            <div className={styles.activityPanel}>
              <div className={styles.hostPanelHeading}>
                <span>SECURITY & ACTIVITY</span>
                <strong>Meeting audit</strong>
              </div>
              {audit.length === 0 && (
                <p className={styles.emptyState}>No activity recorded yet.</p>
              )}
              {audit.map((event) => (
                <article className={styles.auditRow} key={event.id}>
                  <span />
                  <div>
                    <strong>{auditLabel(event)}</strong>
                    <small>
                      {event.actorDisplayName} ·{" "}
                      {new Intl.DateTimeFormat(undefined, {
                        hour: "numeric",
                        minute: "2-digit"
                      }).format(new Date(event.createdAt))}
                    </small>
                  </div>
                </article>
              ))}
            </div>
          )}
        </aside>
      </div>
    </LiveKitRoom>
  );
}
