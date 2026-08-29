import { Module } from '@nestjs/common';
import { ShiftsController } from './shifts.controller';

/**
 * Shift lifecycle: open, dispatch, and hand-edit the package set.
 *
 * A shift is a `vrp_optimization` row. Controller-only for now — see
 * PackagesModule for why the contract lands before the implementation.
 */
@Module({
    controllers: [ShiftsController],
    providers: [],
})
export class ShiftsModule { }
