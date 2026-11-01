import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '@toka/nest-common';
import { type AuditPage, type AuditStatsView, GetAuditStatsQuery, ListAuditEventsQuery } from '../../application/audit-queries';
import { ListAuditEventsDto } from './dto/audit.dto';

/** Solo lectura: audit no expone ninguna ruta que escriba, actualice o borre. */
@Controller('api/v1/audit')
export class AuditController {
  constructor(
    private readonly listEvents: ListAuditEventsQuery,
    private readonly getStats: GetAuditStatsQuery,
  ) {}

  @Get('events')
  @RequirePermissions('audit:read')
  list(@Query() query: ListAuditEventsDto): Promise<AuditPage> {
    return this.listEvents.execute(query);
  }

  @Get('stats')
  @RequirePermissions('audit:read')
  stats(): Promise<AuditStatsView> {
    return this.getStats.execute();
  }
}
