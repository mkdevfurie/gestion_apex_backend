import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../auth/auth.guard.js';
import {
  userCreateSchema,
  userUpdateSchema,
  type AuthUser,
  type UserCreateInput,
  type UserUpdateInput,
} from '../shared/index.js';
import { UsersService } from './users.service.js';

const uuid = z.string().uuid();

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('viewUsers')
  list() {
    return this.users.list();
  }

  /** Crée le compte avec un mot de passe provisoire, renvoyé une seule fois. */
  @Post()
  @RequirePermission('manageUsers')
  create(@Body({ schema: userCreateSchema }) body: UserCreateInput, @CurrentUser() actor: AuthUser) {
    return this.users.create(body, actor);
  }

  @Patch(':id')
  @RequirePermission('manageUsers')
  update(
    @Param('id', { schema: uuid }) id: string,
    @Body({ schema: userUpdateSchema }) body: UserUpdateInput,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.users.update(id, body, actor);
  }

  @Post(':id/reset-password')
  @RequirePermission('manageUsers')
  @HttpCode(200)
  resetPassword(@Param('id', { schema: uuid }) id: string, @CurrentUser() actor: AuthUser) {
    return this.users.resetPassword(id, actor);
  }
}
