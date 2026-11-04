import {test, expect} from './sandbox';

test.use({entry:'weather'});
test('浏览器获取天气但不把原始定位信息放进快照或缓存', async ({page,sandboxURL}) => {
  const requests: string[] = [];
  await page.route('https://get.geojs.io/v1/ip/geo.json', async route => {
    requests.push(route.request().url());
    expect(route.request().headers()).not.toHaveProperty('authorization');
    expect(route.request().headers()).not.toHaveProperty('cookie');
    expect(route.request().headers()).not.toHaveProperty('referer');
    await route.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:{city:'Hangzhou',country_code:'CN',latitude:'30.2731',longitude:'120.1594',ip:'RAW_IP_CANARY'}});
  });
  await page.route('https://api.open-meteo.com/v1/forecast?*', async route => {
    requests.push(route.request().url());
    const url = new URL(route.request().url());
    expect(url.searchParams.get('latitude')).toBe('30.3');
    expect(url.searchParams.get('longitude')).toBe('120.2');
    await route.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:{current:{time:Math.floor(Date.now()/1000)-300,temperature_2m:12,
      relative_humidity_2m:67,weather_code:0,wind_speed_10m:9},
      current_units:{time:'unixtime',temperature_2m:'°C',relative_humidity_2m:'%',wind_speed_10m:'km/h'}}});
  });
  await page.goto(sandboxURL);
  await expect(page.getByLabel('城市天气')).toContainText('Hangzhou');
  await page.getByRole('button',{name:'读取快照'}).click();
  const wire = await page.getByLabel('城市天气').textContent();
  expect(JSON.parse(wire!).temperature_c).toBe(12);
  expect(wire).not.toMatch(/RAW_IP|latitude|longitude/);
  const saved = await page.evaluate(() => sessionStorage.getItem('saudade-current-weather-v1'));
  expect(saved).toContain('Open-Meteo');
  expect(saved).not.toMatch(/RAW_IP|latitude|longitude/);
  expect(requests).toHaveLength(2);
});

test('定位缺失时保持未知，不再请求天气或阻塞使用', async ({page,sandboxURL}) => {
  await page.goto(sandboxURL);
  await expect(page.getByLabel('城市天气')).toHaveText('null');
  await page.getByRole('button',{name:'读取快照'}).click();
  await expect(page.getByLabel('城市天气')).toHaveText('null');
});
