import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../auth/auth.guard.js';
import {
  companyUpdateSchema,
  settingsUpdateSchema,
  warehouseCreateSchema,
  warehouseUpdateSchema,
  type AuthUser,
  type CompanyUpdate,
  type SettingsUpdate,
  type WarehouseCreate,
  type WarehouseUpdate,
} from '../shared/index.js';
import { SettingsService } from './settings.service.js';

@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** Lisibles par tous les connectés : les interfaces s'y conforment (remise max, TVA…). */
  @Get('settings')
  get() {
    return this.settings.get();
  }

  @Patch('settings')
  @RequirePermission('manageSettings')
  update(@Body({ schema: settingsUpdateSchema }) body: SettingsUpdate, @CurrentUser() user: AuthUser) {
    return this.settings.update(body, user);
  }

  @Get('company')
  company() {
    return this.settings.company();
  }

  @Patch('company')
  @RequirePermission('manageSettings')
  updateCompany(@Body({ schema: companyUpdateSchema }) body: CompanyUpdate, @CurrentUser() user: AuthUser) {
    return this.settings.updateCompany(body, user);
  }

  /** ?all=true : y compris les dépôts désactivés (écran de paramétrage). */
  @Get('warehouses')
  warehouses(@Query('all', { schema: z.stringbool().optional() }) all?: boolean) {
    return this.settings.warehouses(all ?? false);
  }

  @Post('warehouses')
  @RequirePermission('manageSettings')
  createWarehouse(@Body({ schema: warehouseCreateSchema }) body: WarehouseCreate, @CurrentUser() user: AuthUser) {
    return this.settings.createWarehouse(body, user);
  }

  @Patch('warehouses/:id')
  @RequirePermission('manageSettings')
  updateWarehouse(
    @Param('id', { schema: z.string().uuid() }) id: string,
    @Body({ schema: warehouseUpdateSchema }) body: WarehouseUpdate,
    @CurrentUser() user: AuthUser,
  ) {
    return this.settings.updateWarehouse(id, body, user);
  }
}
