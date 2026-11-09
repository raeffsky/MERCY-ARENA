const { test, expect } = require('@playwright/test');

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
});
