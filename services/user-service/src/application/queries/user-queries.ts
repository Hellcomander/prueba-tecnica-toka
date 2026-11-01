import { Inject, Injectable } from '@nestjs/common';
import type { Page } from '@toka/contracts';
import { DomainError } from '../../domain/shared/domain-error';
import { STATS_CACHE, type StatsCache } from '../ports';
import { type ListUsersParams, USER_READ_MODEL, type UserReadModel, type UserStats, type UserView } from './read-model';

/** Lado de lectura: no pasa por transacciones ni emite eventos. */
@Injectable()
export class ListUsersQuery {
  constructor(@Inject(USER_READ_MODEL) private readonly readModel: UserReadModel) {}

  async execute(params: ListUsersParams): Promise<Page<UserView>> {
    const { items, total } = await this.readModel.list(params);
    return { items, page: params.page, pageSize: params.pageSize, total };
  }
}

@Injectable()
export class GetUserQuery {
  constructor(@Inject(USER_READ_MODEL) private readonly readModel: UserReadModel) {}

  async execute(userId: string): Promise<UserView> {
    const view = await this.readModel.get(userId);
    if (!view) throw new DomainError('USER_NOT_FOUND', 'not_found', 'El usuario no existe');
    return view;
  }
}

/** Estadísticas del dashboard: cache-aside sobre Redis (el adaptador degrada a miss si Redis falla). */
@Injectable()
export class GetUserStatsQuery {
  constructor(
    @Inject(USER_READ_MODEL) private readonly readModel: UserReadModel,
    @Inject(STATS_CACHE) private readonly cache: StatsCache,
  ) {}

  async execute(): Promise<UserStats> {
    const cached = await this.cache.get();
    if (cached) return cached;
    const stats = await this.readModel.stats();
    await this.cache.set(stats);
    return stats;
  }
}
