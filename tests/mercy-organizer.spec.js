const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test.describe('MERCY ORGANIZER private workspace', () => {
  test('assigned organizer can access the private cabinet and create a draft tournament', async ({ page }) => {
    let createdPayload = null;
    let created = false;
    const tournaments = () => created ? [{
      id: 74, title: 'AUTUMN ARENA CUP', format: 'single_elimination', status: 'draft',
      max_teams: 8, applications_count: 0, approved_teams: 0, matches_count: 0
    }] : [];
    await page.route('**/api/v1/me', route => route.fulfill({json:{
      authenticated:true,is_owner:false,access:'organizer',
      account:{id:'organizer-uid',email:'organizer@example.test',name:'Tournament Staff'},
      roles:['organizer'],profile:null,notifications:{unread_count:0}
    }}));
    await page.route('**/api/v1/organizer', async route => {
      if (route.request().method() === 'POST') {
        createdPayload = route.request().postDataJSON();
        created = true;
        await route.fulfill({json:{data:{id:74,title:createdPayload.data.title,status:'draft'}}});
        return;
      }
      await route.fulfill({json:{data:{
        tournaments:tournaments(),applications:[],matches:[],seasons:[]
      }}});
    });
    await page.goto('/#/organizer');
    await expect(page.locator('#adminDashboard')).toBeVisible();
    await expect(page.locator('#orgContent')).toContainText('Твои турниры');
    await page.locator('[data-org-tab="tournaments"]').click();
    await page.locator('#orgCreateTournament [name="title"]').fill('AUTUMN ARENA CUP');
    await page.locator('#orgCreateTournament [name="max_teams"]').fill('8');
    await page.locator('#orgCreateTournament').getByRole('button',{name:'Создать черновик'}).click();
    await expect.poll(() => createdPayload && createdPayload.action).toBe('create_tournament');
    expect(createdPayload.data.title).toBe('AUTUMN ARENA CUP');
    expect(createdPayload.data.max_teams).toBe('8');
    await expect(page.locator('#orgContent')).toContainText('AUTUMN ARENA CUP');
  });

  test('assigned organizer can start a published tournament after teams and bracket are ready', async ({ page }) => {
    let started = false;
    let startPayload = null;
    await page.route('**/api/v1/me', route => route.fulfill({json:{
      authenticated:true,is_owner:false,access:'organizer',
      account:{id:'organizer-uid',email:'organizer@example.test',name:'Tournament Staff'},
      roles:['organizer'],profile:null,notifications:{unread_count:0}
    }}));
    await page.route('**/api/v1/organizer', async route => {
      if (route.request().method() === 'POST') {
        startPayload = route.request().postDataJSON();
        started = startPayload.action === 'start_tournament';
        await route.fulfill({json:{data:{id:75,title:'MERCY START CUP',status:'active'}}});
        return;
      }
      await route.fulfill({json:{data:{tournaments:[{
        id:75,title:'MERCY START CUP',format:'single_elimination',
        status:started?'active':'published',approved_teams:2,matches_count:4,
        applications_count:2,max_teams:8
      }],applications:[],matches:[],seasons:[]}}});
    });
    page.on('dialog', dialog => dialog.accept());
    await page.goto('/#/organizer');
    await page.locator('[data-org-tab="tournaments"]').click();
    const startButton = page.locator('[data-org-start="75"]');
    await expect(startButton).toBeVisible();
    await startButton.click();
    await expect.poll(() => startPayload && startPayload.action).toBe('start_tournament');
    expect(startPayload.id).toBe('75');
    await expect(page.locator('#orgContent')).toContainText('Идёт');
    await expect(page.locator('[data-org-start="75"]')).toHaveCount(0);
  });
});

test('server start action requires an owned published tournament, two approved teams and a generated bracket', () => {
  const api = fs.readFileSync(path.join(process.cwd(), 'functions/api/v1/organizer.js'), 'utf8');
  expect(api).toContain('if(action==="start_tournament")');
  expect(api).toContain('before.status!=="published"');
  expect(api).toContain('NOT_ENOUGH_TEAMS');
  expect(api).toContain('BRACKET_REQUIRED');
  expect(api).toContain("SET status='active'");
  expect(api).toContain('organizer_tournament_started');
});
