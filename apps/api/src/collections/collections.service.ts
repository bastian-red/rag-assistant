/**
 * The signed-in person's collections, with their documents counted by state.
 *
 * Every query here filters by `ownerId`. That filter is the whole of
 * authorisation in this API (there are no roles), so it is the first thing
 * `test/collections.test.ts` proves: a second person's collections never
 * appear, whatever they are called.
 */
import { Injectable } from '@nestjs/common';
import { COLLECTION_NAME_UNIQUE, violatedUniqueIndex } from '@rag/db';
import {
  DomainError,
  countDocuments,
  type CollectionList,
  type CollectionSummary,
  type DocumentStatus,
} from '@rag/shared';

import { PrismaService } from '../infra/prisma.service';

@Injectable()
export class CollectionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ownerId: string): Promise<CollectionList> {
    const [collections, counts] = await Promise.all([
      this.prisma.client.collection.findMany({
        where: { ownerId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.client.document.groupBy({
        by: ['collectionId', 'status'],
        where: { ownerId },
        _count: { _all: true },
      }),
    ]);
    const byCollection = new Map<string, Partial<Record<DocumentStatus, number>>>();
    for (const row of counts) {
      const statuses = byCollection.get(row.collectionId) ?? {};
      statuses[row.status] = row._count._all;
      byCollection.set(row.collectionId, statuses);
    }
    return {
      collections: collections.map((c) => ({
        id: c.id,
        name: c.name,
        documents: countDocuments(byCollection.get(c.id) ?? {}),
      })),
    };
  }

  async create(ownerId: string, name: string): Promise<CollectionSummary> {
    try {
      const row = await this.prisma.client.collection.create({
        data: { ownerId, name },
        select: { id: true, name: true },
      });
      return { ...row, documents: countDocuments({}) };
    } catch (error) {
      if (violatedUniqueIndex(error, COLLECTION_NAME_UNIQUE)) {
        throw new DomainError('CONFLICT', `You already have a collection called “${name}”.`);
      }
      throw error;
    }
  }

  async assertOwned(ownerId: string, id: string): Promise<void> {
    const owned = await this.prisma.client.collection.count({ where: { id, ownerId } });
    if (owned === 0) throw new DomainError('NOT_FOUND', 'No such collection.');
  }
}
