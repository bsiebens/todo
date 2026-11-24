import { describe, expect, it } from 'vitest';
import { detectAndParse, findDuplicates, parseCsv, parseLooseDate } from './importers';

const today = '2026-11-24'; // Tuesday

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, newlines in fields, CRLF and BOM', () => {
    const rows = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
    ]);
  });
  it('reads semicolon separated files', () => {
    expect(parseCsv('Title;Due\nPay rent;2026-12-01')).toEqual([
      ['Title', 'Due'],
      ['Pay rent', '2026-12-01'],
    ]);
  });
});

describe('parseLooseDate', () => {
  it('reads ISO, d/m/y, m/d/y when clear, and words', () => {
    expect(parseLooseDate('2026-12-01', today)).toEqual({ date: '2026-12-01', time: null });
    expect(parseLooseDate('2026-12-01 17:30', today)).toEqual({ date: '2026-12-01', time: '17:30' });
    expect(parseLooseDate('3/12/2026', today)).toEqual({ date: '2026-12-03', time: null });
    expect(parseLooseDate('12/25/2026', today)).toEqual({ date: '2026-12-25', time: null });
    expect(parseLooseDate('tomorrow', today)).toEqual({ date: '2026-11-25', time: null });
    expect(parseLooseDate('Dec 5 2027 14:00', today)).toEqual({ date: '2027-12-05', time: '14:00' });
    expect(parseLooseDate('someday', today)).toBeNull();
  });
});

describe('Todoist CSV', () => {
  const csv = [
    'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT',
    'task,Submit expense report @finance,Receipts in Drive,1,1,Bernard (1),,tomorrow 17:00,en,Europe/Brussels,30,minute',
    'note,Ask Anna about the hotel bill,,,,Bernard (1),,,,,,',
    'task,Collect receipts,,4,2,,,,,,,',
    'task,Scan them,,4,3,,,,,,,',
    ',,,,,,,,,,,',
    'section,Clients:,,,,,,,,,,',
    'task,Water plants,,4,1,,,every week,en,,,',
    'task,Odd one,,2,1,,,whenever,en,,,',
  ].join('\n');
  const r = detectAndParse([{ name: 'Work [2203306141].csv', text: csv }], today);

  it('detects the format and reads tasks, labels, priority and duration', () => {
    expect(r.format).toBe('todoist');
    expect(r.items).toHaveLength(3);
    const [a] = r.items;
    expect(a).toMatchObject({ title: 'Submit expense report', tags: ['finance'], priority: 3, dueDate: '2026-11-25', dueTime: '17:00', projectPath: 'Work', estimateMin: 30 });
    expect(a!.notes).toEqual(['Ask Anna about the hotel bill']);
  });
  it('turns sub-tasks into a checklist in the description', () => {
    expect(r.items[0]!.description).toBe('Receipts in Drive\n- [ ] Collect receipts\n  - [ ] Scan them\n');
  });
  it('puts sections under the project and reads repeats', () => {
    expect(r.items[1]).toMatchObject({ title: 'Water plants', projectPath: 'Work/Clients', recurrence: { rule: 'FREQ=WEEKLY', mode: 'schedule' } });
  });
  it('keeps a date it cannot read in the description and warns', () => {
    expect(r.items[2]!.description).toContain('Todoist date: whenever');
    expect(r.warnings).toHaveLength(1);
  });
});

describe('TickTick CSV', () => {
  const csv = [
    '"Date: 2026-11-24+0000"',
    '"Version: 7.1"',
    '"Status: \n0 Normal\n1 Completed\n2 Archived"',
    '"Folder Name","List Name","Title","Kind","Tags","Content","Is Check list","Start Date","Due Date","Reminder","Repeat","Priority","Status","Created Time","Completed Time","Order","Timezone","Is All Day","Is Floating","Column Name","Column Order","View Mode","taskId","parentId"',
    '"Work","Admin","Renew passport","TEXT","docs, urgent","Bring photo","N","","2026-12-02T00:00:00+0000","","RRULE:FREQ=YEARLY;INTERVAL=1","5","0","2026-11-01T10:00:00+0000","","1","Europe/Brussels","true","false","","","list","11",""',
    '"","Inbox","Fill form","TEXT","","","N","","","","","0","2","2026-11-01T10:00:00+0000","2026-11-02T10:00:00+0000","2","Europe/Brussels","false","false","","","list","12","11"',
    '"","Inbox","Buy milk","TEXT","","","N","","","","","1","1","2026-11-01T10:00:00+0000","2026-11-02T10:00:00+0000","3","Europe/Brussels","false","false","","","list","13",""',
  ].join('\n');
  const r = detectAndParse([{ name: 'TickTick-backup.csv', text: csv }], today);

  it('reads lists, tags, priority, status, repeat and child tasks', () => {
    expect(r.format).toBe('ticktick');
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      title: 'Renew passport',
      projectPath: 'Work/Admin',
      tags: ['docs', 'urgent'],
      priority: 3,
      dueDate: '2026-12-02',
      dueTime: null,
      recurrence: { rule: 'FREQ=YEARLY;INTERVAL=1' },
      description: 'Bring photo\n- [x] Fill form\n',
    });
    expect(r.items[1]).toMatchObject({ title: 'Buy milk', projectPath: null, status: 'done', priority: 1 });
  });
});

describe('generic CSV', () => {
  it('reads an Outlook-style task export', () => {
    const csv = 'Subject,Due Date,Categories,Notes,Priority,Status\n"Call plumber",28/11/2026,"home; urgent",Leaking tap,High,Not Started\nOld thing,,,,Normal,Completed\n';
    const r = detectAndParse([{ name: 'tasks.csv', text: csv }], today);
    expect(r.format).toBe('csv');
    expect(r.items[0]).toMatchObject({ title: 'Call plumber', dueDate: '2026-11-28', tags: ['home', 'urgent'], description: 'Leaking tap', priority: 3, status: 'todo' });
    expect(r.items[1]).toMatchObject({ title: 'Old thing', status: 'done', priority: 0 });
  });
  it('says so when there is no title column', () => {
    const r = detectAndParse([{ name: 'x.csv', text: 'foo,bar\n1,2' }], today);
    expect(r.items).toHaveLength(0);
    expect(r.warnings[0]).toMatch(/title column/i);
  });
});

describe('text list', () => {
  it('reads quick-add syntax, checkboxes, headings and indented checklists', () => {
    const text = ['# Home', '- [ ] Fix bike fri !high', '  - [ ] buy tube', '- [x] Book dentist', '', '## Work', '* Send report tomorrow 9:00 #finance', 'Plain line @Errands'].join('\n');
    const r = detectAndParse([{ name: 'pasted', text }], today);
    expect(r.format).toBe('text');
    expect(r.items.map((i) => [i.title, i.projectPath, i.status])).toEqual([
      ['Fix bike', 'Home', 'todo'],
      ['Book dentist', 'Home', 'done'],
      ['Send report', 'Work', 'todo'],
      ['Plain line', 'Errands', 'todo'],
    ]);
    expect(r.items[0]).toMatchObject({ priority: 3, dueDate: '2026-11-27', description: '- [ ] buy tube\n' });
    expect(r.items[2]).toMatchObject({ dueDate: '2026-11-25', dueTime: '09:00', tags: ['finance'] });
  });
});

describe('ToDo JSON export', () => {
  it('reads tasks back with project paths, tags, notes and repeats', () => {
    const data = {
      format: 'todo-export',
      tasks: [{ id: 't1', title: 'A', description: '', status: 'todo', priority: 2, dueDate: '2026-12-01', dueTime: null, estimateMin: null, projectId: 'p2', seriesId: 's1', createdAt: '2026-11-01T00:00:00Z', completedAt: null }],
      projects: [
        { id: 'p1', parentId: null, name: 'Work', color: null, context: null, urgencyWeight: null, sortKey: 'a0', archivedAt: null },
        { id: 'p2', parentId: 'p1', name: 'Admin', color: null, context: null, urgencyWeight: null, sortKey: 'a0', archivedAt: null },
      ],
      tags: [{ id: 'g1', name: 'finance' }],
      taskTags: [{ taskId: 't1', tagId: 'g1' }],
      notes: [
        { taskId: 't1', body: 'second', kind: 'user' },
        { taskId: 't1', body: 'Created', kind: 'system' },
        { taskId: 't1', body: 'first', kind: 'user' },
      ],
      series: [{ id: 's1', rrule: 'FREQ=MONTHLY', mode: 'schedule' }],
    };
    const r = detectAndParse([{ name: 'todo-export.json', text: JSON.stringify(data) }], today);
    expect(r.format).toBe('todo-json');
    expect(r.items[0]).toMatchObject({ title: 'A', projectPath: 'Work/Admin', tags: ['finance'], notes: ['first', 'second'], recurrence: { rule: 'FREQ=MONTHLY', mode: 'schedule' } });
  });
});

describe('findDuplicates', () => {
  it('flags tasks you already have and repeats within the file', () => {
    const items = detectAndParse([{ name: 'p', text: 'Pay rent\nCall mum\ncall mum' }], today).items;
    expect([...findDuplicates(items, [{ title: 'pay rent', dueDate: null }])]).toEqual([0, 2]);
  });
});
