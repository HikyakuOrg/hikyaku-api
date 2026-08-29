import { Module } from '@nestjs/common';
import { PackagesController } from './packages.controller';

/**
 * Package creation and the assignment it triggers.
 *
 * Controller-only for now: this module lands ahead of its service so the
 * OpenAPI document carries the final DTO shapes, which the web dashboard and
 * the mobile app both generate their clients from.
 */
@Module({
    controllers: [PackagesController],
    providers: [],
})
export class PackagesModule { }
