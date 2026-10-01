export type MeetingRole = "host" | "cohost" | "participant";

export type MeetingStatus = "scheduled" | "live" | "ended" | "cancelled";

export type MeetingSummary = {
  roomName: string;
  title: string;
  status: MeetingStatus;
  joinCode?: string;
  role: MeetingRole;
  scheduledStartAt?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  waitingRoomEnabled: boolean;
  allowParticipantScreenShare: boolean;
};

export type MeetingCreateInput = {
  mode: "instant" | "scheduled";
  title: string;
  scheduledStartAt?: string | null;
  waitingRoomEnabled: boolean;
  allowParticipantScreenShare: boolean;
};

export type MeetingJoinContext = {
  roomName: string;
  title: string;
  role: MeetingRole;
  status: MeetingStatus;
  canEnter: boolean;
  recordingActive: boolean;
  scheduledStartAt?: string | null;
  scheduledEndAt?: string | null;
  timezone?: string;
  waitingRoomEnabled?: boolean;
  admissionStatus?: "waiting" | "admitted" | "denied";
  defaultMicrophoneOn?: boolean;
  defaultCameraOn?: boolean;
  allowChat?: boolean;
  allowParticipantScreenShare?: boolean;
  presenter?: boolean;
  accessScope?: string;
  joinCode?: string | null;
};

export type MeetingCapabilities = {
  privateCodes: boolean;
  waitingRoom: boolean;
  audio: boolean;
  video: boolean;
  screenShare: boolean;
  chat: boolean;
  reactions: boolean;
  handRaise: boolean;
  participantControls: boolean;
  attendance: boolean;
  recording: boolean;
  mobileScreenShare: boolean;
};

export const tamishraMeetCapabilities: MeetingCapabilities = {
  privateCodes: true,
  waitingRoom: true,
  audio: true,
  video: true,
  screenShare: true,
  chat: true,
  reactions: true,
  handRaise: true,
  participantControls: true,
  attendance: true,
  recording: true,
  mobileScreenShare: true
};

export function normalizeMeetingCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
}
