const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

function source(file) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

test.describe('MERCY ARENA API guardrails', () => {
  test('global administration and Circuit mutations are restricted to the platform owner', () => {
    for (const file of [
      'functions/api/v1/admin.js',
      'functions/api/v1/circuit/qualify.js',
      'functions/api/v1/uploads/season-cover.js',
      'functions/api/v1/uploads/tournament-poster.js'
    ]) {
      expect(source(file), file).toContain('isOwnerAccount');
    }
  });

  test('organizers can generate brackets only for their own tournaments', () => {
    const brackets = source('functions/api/v1/brackets.js');
    expect(brackets).toContain('isOwnerAccount');
    expect(brackets).toContain('String(tournament.organizer_id) !== String(auth.user.id)');
  });

  test('public match schedule hides placeholder matches without assigned teams', () => {
    const matches = source('functions/api/v1/matches.js');
    expect(matches).toContain('(m.team_a_id IS NOT NULL OR m.team_b_id IS NOT NULL)');
  });

  test('public tournament details count only active registered teams', () => {
    const tournaments = source('functions/api/v1/tournaments.js');
    expect(tournaments).toContain("registered_team.status='active'");
    expect(tournaments).toContain("tm.status='active'");
  });

  test('public match and ranking APIs exclude unpublished tournaments', () => {
    expect(source('functions/api/v1/matches.js')).toContain("visible_tournament.published_at IS NOT NULL");
    const rankings = source('functions/api/v1/rankings.js');
    expect(rankings).toContain("tour.published_at IS NOT NULL");
    expect(rankings).toContain("tour.status!='draft'");
  });
});
