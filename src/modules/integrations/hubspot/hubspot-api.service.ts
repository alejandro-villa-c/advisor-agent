import { Injectable } from '@nestjs/common';
import { HubspotTokenService } from './hubspot-token.service';

export type HubspotContactSummary = {
  id: string;
  email: string | undefined;
  firstName: string | undefined;
  lastName: string | undefined;
};

export type HubspotNoteSummary = {
  id: string;
  body: string | undefined;
  timestamp: string | undefined;
};

export type HubspotNoteWithContactSummary = {
  id: string;
  hubspotContactId: string | undefined;
  body: string | undefined;
  timestamp: string | undefined;
};

@Injectable()
export class HubspotApiService {
  private readonly baseUrl = 'https://api.hubapi.com';

  constructor(private readonly hubspotTokenService: HubspotTokenService) {}

  async getContact(userId: number, contactId: string): Promise<HubspotContactSummary> {
    const data = await this.hubspotRequest(
      userId,
      'GET',
      `/crm/v3/objects/contacts/${contactId}?properties=email,firstname,lastname`,
    );

    const id = readString(data, 'id');
    if (!id) throw new Error('HubSpot: getContact returned no id');

    const props = readRecord(data, 'properties');
    const email = (props ? readString(props, 'email') : null) ?? undefined;
    const firstName = (props ? readString(props, 'firstname') : null) ?? undefined;
    const lastName = (props ? readString(props, 'lastname') : null) ?? undefined;

    return { id, email, firstName, lastName };
  }

  async deleteContact(userId: number, contactId: string): Promise<void> {
    await this.hubspotRequest(userId, 'DELETE', `/crm/v3/objects/contacts/${contactId}`);
  }

  async deleteNote(userId: number, noteId: string): Promise<void> {
    await this.hubspotRequest(userId, 'DELETE', `/crm/v3/objects/notes/${noteId}`);
  }

  async searchContacts(
    userId: number,
    query: string,
    limit = 10,
  ): Promise<HubspotContactSummary[]> {
    const q = query.trim();
    if (!q) return [];

    const body: Record<string, unknown> = {
      limit,
      properties: ['email', 'firstname', 'lastname'],
    };

    const filterGroups: Array<{ filters: Array<Record<string, unknown>> }> = [];

    const looksLikeEmail = q.includes('@');
    if (looksLikeEmail) {
      filterGroups.push({
        filters: [
          {
            propertyName: 'email',
            operator: 'EQ',
            value: q,
          },
        ],
      });
    }

    filterGroups.push({
      filters: [
        {
          propertyName: 'email',
          operator: 'CONTAINS_TOKEN',
          value: q,
        },
      ],
    });

    const parts = q.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      filterGroups.push({
        filters: [{ propertyName: 'firstname', operator: 'CONTAINS_TOKEN', value: q }],
      });
      filterGroups.push({
        filters: [{ propertyName: 'lastname', operator: 'CONTAINS_TOKEN', value: q }],
      });
    } else {
      filterGroups.push({
        filters: [
          { propertyName: 'firstname', operator: 'CONTAINS_TOKEN', value: parts[0] },
          { propertyName: 'lastname', operator: 'CONTAINS_TOKEN', value: parts.slice(1).join(' ') },
        ],
      });
    }

    body.filterGroups = filterGroups;

    const data = await this.hubspotRequest(userId, 'POST', '/crm/v3/objects/contacts/search', body);

    const results = readArray(data, 'results');
    const contacts: HubspotContactSummary[] = [];

    for (const r of results) {
      const id = readString(r, 'id');
      if (!id) continue;

      const props = readRecord(r, 'properties');

      const email = (props ? readString(props, 'email') : null) ?? undefined;
      const firstName = (props ? readString(props, 'firstname') : null) ?? undefined;
      const lastName = (props ? readString(props, 'lastname') : null) ?? undefined;

      contacts.push({ id, email, firstName, lastName });
    }

    return contacts;
  }

  async createContact(
    userId: number,
    input: { email: string; firstName?: string; lastName?: string },
  ): Promise<{ id: string }> {
    const body = {
      properties: {
        email: input.email,
        firstname: input.firstName ?? '',
        lastname: input.lastName ?? '',
      },
    };

    const data = await this.hubspotRequest(userId, 'POST', '/crm/v3/objects/contacts', body);
    const id = readString(data, 'id');
    if (!id) throw new Error('HubSpot: createContact succeeded but returned no id');
    return { id };
  }

  async createNoteOnContact(
    userId: number,
    input: { contactId: string; body: string; timestampIso?: string },
  ): Promise<{ noteId: string }> {
    const contactIdNum = Number(input.contactId);
    if (!Number.isFinite(contactIdNum)) {
      throw new Error('HubSpot: contactId must be a numeric string');
    }

    const body = {
      properties: {
        hs_timestamp: input.timestampIso ?? new Date().toISOString(),
        hs_note_body: input.body,
      },
      associations: [
        {
          to: { id: contactIdNum },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: 202,
            },
          ],
        },
      ],
    };

    const data = await this.hubspotRequest(userId, 'POST', '/crm/v3/objects/notes', body);
    const noteId = readString(data, 'id');
    if (!noteId) throw new Error('HubSpot: createNote succeeded but returned no id');
    return { noteId };
  }

  async findOrCreateContactByEmail(
    userId: number,
    input: { email: string; firstName?: string; lastName?: string },
  ): Promise<{ id: string; created: boolean }> {
    const found = await this.searchContacts(userId, input.email, 5);
    const exact = found.find((c) => (c.email ?? '').toLowerCase() === input.email.toLowerCase());
    if (exact) return { id: exact.id, created: false };

    const created = await this.createContact(userId, input);
    return { id: created.id, created: true };
  }

  async listContactsPage(
    userId: number,
    input: { limit?: number; after?: string | null },
  ): Promise<{ results: HubspotContactSummary[]; nextAfter: string | undefined }> {
    const limit = input.limit ?? 100;

    const qs = new URLSearchParams({
      limit: String(limit),
      archived: 'false',
    });

    qs.append('properties', 'email');
    qs.append('properties', 'firstname');
    qs.append('properties', 'lastname');

    if (input.after) qs.set('after', input.after);

    const data = await this.hubspotRequest(
      userId,
      'GET',
      `/crm/v3/objects/contacts?${qs.toString()}`,
    );

    const resultsRaw = readArray(data, 'results');
    const results: HubspotContactSummary[] = [];

    for (const r of resultsRaw) {
      const id = readString(r, 'id');
      if (!id) continue;

      const props = readRecord(r, 'properties');

      const email = (props ? readString(props, 'email') : null) ?? undefined;
      const firstName = (props ? readString(props, 'firstname') : null) ?? undefined;
      const lastName = (props ? readString(props, 'lastname') : null) ?? undefined;

      results.push({ id, email, firstName, lastName });
    }

    const paging = readRecord(data, 'paging');
    const next = paging ? readRecord(paging, 'next') : null;
    const nextAfter = (next ? readString(next, 'after') : null) ?? undefined;

    return { results, nextAfter };
  }

  async listNotesPage(
    userId: number,
    input: { limit?: number; after?: string | null },
  ): Promise<{ results: HubspotNoteWithContactSummary[]; nextAfter: string | undefined }> {
    const limit = clampInt(input.limit ?? 100, 1, 100);

    const qs = new URLSearchParams({
      limit: String(limit),
      archived: 'false',
      properties: 'hs_note_body,hs_timestamp',
      associations: 'contact',
    });

    if (input.after) qs.set('after', input.after);

    const data = await this.hubspotRequest(userId, 'GET', `/crm/v3/objects/notes?${qs.toString()}`);

    const resultsRaw = readArray(data, 'results');
    const results: HubspotNoteWithContactSummary[] = [];

    for (const r of resultsRaw) {
      const id = readString(r, 'id');
      if (!id) continue;

      const props = readRecord(r, 'properties');
      const body = (props ? readString(props, 'hs_note_body') : null) ?? undefined;
      const timestamp = (props ? readString(props, 'hs_timestamp') : null) ?? undefined;

      const associations = readRecord(r, 'associations');
      const contactsAssoc =
        (associations ? readRecord(associations, 'contacts') : null) ??
        (associations ? readRecord(associations, 'contact') : null);

      const assocResults = contactsAssoc ? readArray(contactsAssoc, 'results') : [];

      let hubspotContactId: string | undefined;
      for (const ar of assocResults) {
        const assocId =
          readIdAsString(ar, 'id') ??
          readIdAsString(ar, 'toObjectId') ??
          readIdAsString(ar, 'toObjectIdStr');
        if (assocId) {
          hubspotContactId = assocId;
          break;
        }
      }

      results.push({ id, hubspotContactId, body, timestamp });
    }

    const paging = readRecord(data, 'paging');
    const next = paging ? readRecord(paging, 'next') : null;
    const nextAfter = (next ? readString(next, 'after') : null) ?? undefined;

    return { results, nextAfter };
  }

  async listNotesForContact(
    userId: number,
    input: { contactId: string; limit?: number },
  ): Promise<HubspotNoteSummary[]> {
    const contactIdNum = Number(input.contactId);
    if (!Number.isFinite(contactIdNum)) {
      throw new Error('HubSpot: contactId must be a numeric string');
    }

    const desiredLimit = clampInt(input.limit ?? 10, 1, 50);

    const out: Array<{ note: HubspotNoteSummary; sortKey: number }> = [];

    let after: string | null = null;
    let page = 0;

    while (out.length < desiredLimit) {
      page += 1;

      const qs = new URLSearchParams({
        limit: '100',
        archived: 'false',
        properties: 'hs_note_body,hs_timestamp',
        associations: 'contact',
      });

      if (after) qs.set('after', after);

      const data = await this.hubspotRequest(
        userId,
        'GET',
        `/crm/v3/objects/notes?${qs.toString()}`,
      );

      const resultsRaw = readArray(data, 'results');

      for (const r of resultsRaw) {
        const id = readString(r, 'id');
        if (!id) continue;

        const associations = readRecord(r, 'associations');
        const contactsAssoc =
          (associations ? readRecord(associations, 'contacts') : null) ??
          (associations ? readRecord(associations, 'contact') : null);

        const assocResults = contactsAssoc ? readArray(contactsAssoc, 'results') : [];

        let isForContact = false;
        for (const ar of assocResults) {
          const assocId =
            readIdAsString(ar, 'id') ??
            readIdAsString(ar, 'toObjectId') ??
            readIdAsString(ar, 'toObjectIdStr');
          if (assocId && assocId === String(contactIdNum)) {
            isForContact = true;
            break;
          }
        }

        if (!isForContact) continue;

        const props = readRecord(r, 'properties');
        const body = (props ? readString(props, 'hs_note_body') : null) ?? undefined;
        const timestamp = (props ? readString(props, 'hs_timestamp') : null) ?? undefined;

        const sortKey = toSortableTimestamp(timestamp);

        out.push({
          note: { id, body, timestamp },
          sortKey,
        });

        if (out.length >= desiredLimit) break;
      }

      const paging = readRecord(data, 'paging');
      const next = paging ? readRecord(paging, 'next') : null;
      const nextAfter = (next ? readString(next, 'after') : null) ?? undefined;

      if (!nextAfter) break;
      after = nextAfter;

      if (page >= 10) break;
    }

    out.sort((a, b) => b.sortKey - a.sortKey);

    return out.slice(0, desiredLimit).map((x) => x.note);
  }

  private async hubspotRequest(
    userId: number,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const token = await this.hubspotTokenService.getValidAccessToken(userId);

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const json: unknown = safeJson(text);

    if (!res.ok) {
      const message = extractHubspotErrorMessage(json) ?? `${res.status} ${res.statusText}`;
      throw new Error(`HubSpot API error: ${message}`);
    }

    return json;
  }
}

function safeJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function readRecord(obj: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(obj)) return null;
  const v = obj[key];
  return isRecord(v) ? v : null;
}

function readArray(obj: unknown, key: string): unknown[] {
  if (!isRecord(obj)) return [];
  const v = obj[key];
  return Array.isArray(v) ? v : [];
}

function readString(obj: unknown, key: string): string | null {
  if (!isRecord(obj)) return null;
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

function readIdAsString(obj: unknown, key: string): string | null {
  if (!isRecord(obj)) return null;
  const v = obj[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  const x = Math.trunc(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function toSortableTimestamp(ts: string | undefined): number {
  if (!ts) return 0;

  const asNum = Number(ts);
  if (Number.isFinite(asNum)) return asNum;

  const asDate = Date.parse(ts);
  return Number.isFinite(asDate) ? asDate : 0;
}

function extractHubspotErrorMessage(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const msg = json['message'];
  if (typeof msg === 'string') return msg;

  const errors = json['errors'];
  if (Array.isArray(errors) && errors.length > 0 && isRecord(errors[0])) {
    const m = errors[0]['message'];
    if (typeof m === 'string') return m;
  }
  return null;
}
