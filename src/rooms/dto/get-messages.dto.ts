import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class GetMessagesQueryDto {
  @IsString()
  @IsNotEmpty()
  appId: string;

  @IsString()
  @IsNotEmpty()
  contextType: string;

  @IsOptional()
  @IsString()
  limit?: string;

  @IsOptional()
  @IsString()
  from?: string;
}
