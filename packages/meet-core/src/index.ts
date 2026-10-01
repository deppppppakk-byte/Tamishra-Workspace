export type MeetingRole = "host" | "cohost" | "participant";

export type MeetingPermissions = {
  canShareScreen: boolean;
  canChat: boolean;
  canRaiseHand: boolean;
  canRecord: boolean;
  canAdmitParticipants: boolean;
  canManageParticipants: boolean;
};

export type MeetingParticipant = {
  id: string;
  displayName: string;
  role: MeetingRole;
  microphoneOn: boolean;
  cameraOn: boolean;
  handRaised: boolean;
  isPresenting: boolean;
};

export type MeetingChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  body: string;
  createdAt: string;
};

export type MeetingSummary = {
  id: string;
  title: string;
  startsAt: string;
  durationMinutes: number;
  hostName: string;
  participantCount: number;
};

export const defaultHostPermissions: MeetingPermissions = {
  canShareScreen: true,
  canChat: true,
  canRaiseHand: true,
  canRecord: true,
  canAdmitParticipants: true,
  canManageParticipants: true
};

export const defaultParticipantPermissions: MeetingPermissions = {
  canShareScreen: true,
  canChat: true,
  canRaiseHand: true,
  canRecord: false,
  canAdmitParticipants: false,
  canManageParticipants: false
};

export function createMeetingCode() {
  const segment = () => Math.random().toString(36).slice(2, 5).toUpperCase();
  return `${segment()}-${segment()}-${segment()}`;
}

export function normalizeMeetingCode(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .match(/.{1,3}/g)
    ?.join("-")
    .slice(0, 11) ?? "";
}

export function meetingUrl(baseUrl: string, code: string) {
  const url = new URL(baseUrl);
  url.searchParams.set("room", normalizeMeetingCode(code));
  return url.toString();
}
