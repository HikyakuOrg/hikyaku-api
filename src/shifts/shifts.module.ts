import { Module } from '@nestjs/common';
import { DispatchModule } from 'src/dispatch/dispatch.module';
import { ShiftsController } from './shifts.controller';
import { ShiftsService } from './shifts.service';

/**
 * Shift lifecycle: open, dispatch, and hand-edit the package set.
 *
 * A shift is a `vrp_optimization` row. Exported so OptimisationService.runAdhoc
 * can open one rather than carrying a second implementation of route
 * persistence.
 */
@Module({
    imports: [DispatchModule],
    controllers: [ShiftsController],
    providers: [ShiftsService],
    exports: [ShiftsService],
})
export class ShiftsModule {}
