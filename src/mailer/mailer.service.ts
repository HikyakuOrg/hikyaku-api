import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

@Injectable()
export class MailerService {
    private readonly logger = new Logger(MailerService.name);
    private transporter?: Transporter;

    private getTransporter(): Transporter {
        if (this.transporter) return this.transporter;

        const host = process.env.MAILER_HOST;
        const user = process.env.MAILER_USER;
        const pass = process.env.MAILER_PASSWORD;

        if (!host || !user || !pass) {
            throw new InternalServerErrorException(
                'Mailer is not configured (MAILER_HOST / MAILER_USER / MAILER_PASSWORD missing)',
            );
        }

        this.transporter = nodemailer.createTransport({
            host,
            auth: { user, pass },
        });

        return this.transporter;
    }

    // TODO: Update from, subject and text when we have the actual email content ready
    async sendInvitationEmail(
        to: string,
        orgName: string,
        loginUrl: string,
    ): Promise<void> {
        await this.getTransporter().sendMail({
            from: '',
            to,
            subject: '',
            text: ``,
        });

        this.logger.log(`Invitation email sent to ${to} for org ${orgName}`);
    }
}
