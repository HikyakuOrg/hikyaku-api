import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

@Injectable()
export class MailerService {
    private readonly logger = new Logger(MailerService.name);
    private SENDER_EMAIL = process.env.MAILER_SENDER_EMAIL;
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

    // TODO: Move this to handlebar or allow user to edit the email template
    async sendInvitationEmail(
        to: string,
        orgName: string,
        loginUrl: string,
    ): Promise<void> {
        await this.getTransporter().sendMail({
            from: this.SENDER_EMAIL,
            to,
            subject: `Join the ${orgName} on Hikyaku`,
            html: `
            <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="en">
  <head>
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
    <meta name="x-apple-disable-message-reformatting" />
  </head>
  <body
    dir="ltr"
    lang="en"
    style="background-color:rgb(255,255,255);margin-top:0;margin-bottom:0;margin-right:0;margin-left:0;padding-right:0;padding-left:0">
    <!--$--><!--html--><!--head--><!--body-->
    <table
      border="0"
      width="100%"
      cellpadding="0"
      cellspacing="0"
      role="presentation"
      align="center">
      <tbody>
        <tr>
          <td
            dir="ltr"
            lang="en"
            style='margin-right:auto;margin-left:auto;margin-bottom:auto;margin-top:auto;background-color:rgb(255,255,255);padding-right:8px;padding-left:8px;font-family:ui-sans-serif,system-ui,sans-serif,"Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol","Noto Color Emoji"'>
            <table
              align="center"
              width="100%"
              border="0"
              cellpadding="0"
              cellspacing="0"
              role="presentation"
              style="max-width:465px;margin-right:auto;margin-left:auto;margin-bottom:40px;margin-top:40px;border-radius:0.25rem;border-style:solid;border-width:1px;border-color:rgb(234,234,234)">
              <tbody>
                <tr style="width:100%">
                  <td style="padding:20px">
                    <h1
                      style="margin-right:0;margin-left:0;margin-bottom:30px;margin-top:30px;padding:0;text-align:center;font-weight:400;font-size:24px;color:rgb(0,0,0)">
                      Join <strong>${orgName}</strong>
                    </h1>
                    <p
                      style="font-size:14px;line-height:24px;color:rgb(0,0,0);margin-top:16px;margin-bottom:16px">
                      Hello
                      
                    </p>
                    <p
                      style="font-size:14px;line-height:24px;color:rgb(0,0,0);margin-top:16px;margin-bottom:16px">
                      You have been invited to join <strong>${orgName}</strong> team
                    </p> 
                    <table
                      align="center"
                      width="100%"
                      border="0"
                      cellpadding="0"
                      cellspacing="0"
                      role="presentation"
                      style="margin-top:32px;margin-bottom:32px;text-align:center">
                      <tbody>
                        <tr>
                          <td>
                            <a
                              href="${loginUrl}"
                              style="line-height:100%;text-decoration:none;display:inline-block;max-width:100%;mso-padding-alt:0px;border-radius:0.25rem;background-color:rgb(0,0,0);padding-right:20px;padding-left:20px;padding-bottom:12px;padding-top:12px;text-align:center;font-weight:600;font-size:12px;color:rgb(255,255,255);text-decoration-line:none"
                              target="_blank"
                              ><span
                                ><!--[if mso]><i style="mso-font-width:500%;mso-text-raise:18" hidden>&#8202;&#8202;</i><![endif]--></span
                              ><span
                                style="max-width:100%;display:inline-block;line-height:120%;mso-padding-alt:0px;mso-text-raise:9px"
                                >Join the team</span
                              ><span
                                ><!--[if mso]><i style="mso-font-width:500%" hidden>&#8202;&#8202;&#8203;</i><![endif]--></span
                              ></a
                            >
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p
                      style="font-size:14px;line-height:24px;color:rgb(0,0,0);margin-top:16px;margin-bottom:16px">
                      or copy and paste this URL into your browser:<!-- -->
                      <a
                        href="${loginUrl}"
                        style="color:rgb(21,93,252);text-decoration-line:none"
                        target="_blank"
                        >${loginUrl}</a
                      >
                    </p>
                    <hr
                      style="width:100%;border:none;border-color:rgb(234,234,234);border-top:1px solid #eaeaea;margin-right:0;margin-left:0;margin-bottom:26px;margin-top:26px;border-style:solid;border-width:1px" />
                  
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
  </body>
</html>
            `,
        });

        this.logger.log(`Invitation email sent to ${to} for org ${orgName}`);
    }
}
