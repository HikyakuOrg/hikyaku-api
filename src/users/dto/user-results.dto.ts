import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
    CreateUserResult,
    DeactivateUsersResult,
    ReactivateUsersResult,
} from '../users.service';

/**
 * Swagger view of the results in `users.service.ts`. The interfaces there stay
 * the source of truth; `implements` is what stops the two drifting.
 */

/** Why one user in a batch could not be processed. */
export class UserBatchFailureDto {
    @ApiProperty({ format: 'uuid' })
    user_id: string;

    @ApiProperty({
        description:
            'Human-readable cause, e.g. "Cannot deactivate your own account". ' +
            'For display only — do not branch on the text.',
    })
    reason: string;
}

/** 201 body of POST /api/v1/users. */
export class CreateUserResultDto implements CreateUserResult {
    @ApiProperty({
        format: 'uuid',
        description: 'Supabase auth id of the invited user.',
    })
    user_id: string;

    @ApiProperty({ format: 'email' })
    user_email: string;

    @ApiProperty()
    user_display_name: string;

    @ApiProperty()
    user_phone_number: string;

    @ApiProperty({ description: 'Role name, echoed from the request.' })
    user_role: string;

    @ApiProperty({
        description:
            'The granted permissions as a JSON-encoded string array, not an ' +
            'array — `JSON.parse` before use. Deduplicated against the request.',
        example: '["team_members.view","vehicles.view"]',
    })
    user_permission: string;

    @ApiProperty({
        type: String,
        format: 'date-time',
        nullable: true,
        description: 'When the invitation email was issued.',
    })
    invited_at: string | null;

    @ApiPropertyOptional({
        description:
            'Short-lived signed URL for uploading the avatar directly to storage. ' +
            'Present only when the request set `user_avatar` — image bytes never ' +
            'pass through this API.',
    })
    user_avatar_upload_url?: string;
}

/**
 * 200 body of DELETE /api/v1/users.
 *
 * Partial success is normal: users are processed independently, so a 200 does
 * not mean every id succeeded. Always check `failed`.
 */
export class DeactivateUsersResultDto implements DeactivateUsersResult {
    @ApiProperty({
        type: [String],
        format: 'uuid',
        description: 'Users banned and signed out of every session.',
    })
    deactivated: string[];

    @ApiProperty({
        type: [UserBatchFailureDto],
        description: 'Users left untouched, with the reason for each.',
    })
    failed: UserBatchFailureDto[];
}

/** 200 body of PATCH /api/v1/users/reactivate. Partial success as above. */
export class ReactivateUsersResultDto implements ReactivateUsersResult {
    @ApiProperty({
        type: [String],
        format: 'uuid',
        description: 'Users whose deactivation ban was lifted.',
    })
    reactivated: string[];

    @ApiProperty({
        type: [UserBatchFailureDto],
        description: 'Users left untouched, with the reason for each.',
    })
    failed: UserBatchFailureDto[];
}

/** 200 body of PATCH /api/v1/users/role. */
export class UpdateUserRoleResultDto {
    @ApiProperty({ format: 'uuid' })
    user_id: string;

    @ApiProperty({
        description: 'The role now in effect, resolved from the requested name.',
        example: 'Driver',
    })
    role: string;
}
