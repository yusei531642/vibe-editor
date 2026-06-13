// This file is generated from src-tauri/src/team_hub/events.rs via ts-rs.
// Run `npm run generate:team-event-types` after changing TeamHub event payload structs.

export type RoleLintLevel = "warn";

export type RoleLintFinding = { level: RoleLintLevel, category: string, detail: string, 
/**
 * 0.0–1.0 の類似度。`vague_keyword` 系は None。
 */
similarity?: number | null, 
/**
 * 衝突相手 (重複系のみ)。
 */
other_role_id?: string | null, };

export type FileLockConflictSnapshot = { path: string, holderAgentId: string, holderRole: string, acquiredAt: string, };

export type RecruitCancelledPayload = { newAgentId: string, reason: string, };

export type DismissRequestPayload = { teamId: string, agentId: string, };

export type RoleLintWarningPayload = { teamId: string, source: string, roleId?: string | null, taskId?: number | null, assignee?: string | null, message: string, findings: Array<RoleLintFinding>, };

export type FileLockConflictEventPayload = { teamId: string, source: string, taskId: number, assignee: string, message: string, conflicts: Array<FileLockConflictSnapshot>, };

export type InboxReadEventPayload = { teamId: string, messageIds: Array<number>, readByAgentId: string, readByRole: string, readAt: string, };

export type RoleCreatedRolePayload = { id: string, label: string, description: string, instructions: string, instructionsJa: string | null, teamId: string, createdByRole: string, };

export type RoleCreatedPayload = { teamId: string, role: RoleCreatedRolePayload, };
