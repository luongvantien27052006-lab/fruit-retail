import { Controller, Get, SetMetadata } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testAuthEnv } from './helpers/auth-env';
import { createApp } from '../src/bootstrap';
import { Authenticated, Public, RequirePermission, STEP_UP_KEY } from '../src/common/access';
import { listRoutes } from '../src/common/route-access';
import { loadEnv } from '../src/config/env';

// Deny-by-default lúc khởi động (CP03 lát 2). File riêng: mỗi test tạo app riêng trong process — nestjs-cls giữ trạng thái
// plugin ở biến tĩnh, nhiều app trong một process làm hỏng nhau (production: một app mỗi process). App không kết nối DB
// khi chỉ khởi tạo, nên dùng URL giả.

@Controller('_test2')
class UndeclaredController {
  @Get('x')
  x() {
    return 1;
  }
}

class BaseUndeclared {
  @Get('inherited')
  inherited() {
    return 1;
  }
}
@Controller('_test3')
class InheritingController extends BaseUndeclared {
  @Public()
  @Get('own')
  own() {
    return 1;
  }
}

@RequirePermission('store:write')
@Controller('_test4')
class ProtectedWithPublicMethod {
  @Public()
  @Get('open')
  open() {
    return 1;
  }
}

@RequirePermission('store:write')
@Controller('_test6')
class ProtectedWithAuthenticatedMethod {
  @Authenticated()
  @Get('any')
  any() {
    return 1;
  }
}

// @RequireStepUp ở class (kiểu TS chặn, nhưng SetMetadata thô lọt được) ⇒ không khởi động (lát 3 S7)
@SetMetadata(STEP_UP_KEY, true)
@Authenticated()
@Controller('_test7')
class ClassLevelStepUp {
  @Get('x')
  x() {
    return 1;
  }
}

@Public()
@Controller('_test5')
class MultiPathController {
  @Get(['a', 'b'])
  ab() {
    return 1;
  }
}

describe('kiểm quyền route lúc khởi động', () => {
  let env: ReturnType<typeof loadEnv>;
  beforeAll(() => {
    env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL_APP: 'postgresql://u:p@127.0.0.1:1/none',
      REDIS_URL: 'redis://127.0.0.1:1',
      PORT: '0',
      LOG_LEVEL: 'silent',
      ...testAuthEnv(),
    });
  });
  afterAll(() => undefined);

  it('deny-by-default: route thiếu khai báo quyền ⇒ app KHÔNG khởi động', async () => {
    await expect(createApp(env, { logger: false }, { controllers: [UndeclaredController] })).rejects.toThrow(
      /chưa khai báo quyền.*GET \/_test2\/x/,
    );
  });

  it('M1/L3/L4 — route kế thừa thiếu quyền ⇒ không khởi động; @Public trong controller cần quyền ⇒ không khởi động; path mảng liệt kê đủ', async () => {
    await expect(createApp(env, { logger: false }, { controllers: [InheritingController] })).rejects.toThrow(
      /GET \/_test3\/inherited/,
    );
    await expect(createApp(env, { logger: false }, { controllers: [ProtectedWithPublicMethod] })).rejects.toThrow(
      /nới lỏng hơn class.*\/_test4\/open/,
    );
    await expect(
      createApp(env, { logger: false }, { controllers: [ProtectedWithAuthenticatedMethod] }),
    ).rejects.toThrow(/nới lỏng hơn class.*\/_test6\/any/);
    await expect(createApp(env, { logger: false }, { controllers: [ClassLevelStepUp] })).rejects.toThrow(
      /ClassLevelStepUp: @RequireStepUp/,
    );
    const a2 = await createApp(env, { logger: false }, { controllers: [MultiPathController] });
    try {
      const paths = listRoutes(a2)
        .filter((r) => r.controller === 'MultiPathController')
        .map((r) => r.path)
        .sort();
      expect(paths).toEqual(['/_test5/a', '/_test5/b']);
    } finally {
      await a2.close();
    }
  });
});
