declare module '@nestjs/swagger' {
  export function ApiOperation(metadata?: object): MethodDecorator;
  export function ApiParam(metadata?: object): MethodDecorator;
  export function ApiProperty(metadata?: object): PropertyDecorator;
  export function ApiPropertyOptional(metadata?: object): PropertyDecorator;
  export function ApiQuery(metadata?: object): MethodDecorator;
  export function ApiResponse(metadata?: object): MethodDecorator;
  export function ApiTags(...tags: string[]): ClassDecorator & MethodDecorator;
  export function ApiBearerAuth(name?: string): ClassDecorator & MethodDecorator;

  export class DocumentBuilder {
    setTitle(title: string): this;
    setDescription(description: string): this;
    setVersion(version: string): this;
    addBearerAuth(options?: object, name?: string): this;
    addTag(name: string, description?: string): this;
    build(): object;
  }

  export class SwaggerModule {
    static createDocument(app: unknown, config: object): object;
    static setup(path: string, app: unknown, document: object): void;
  }
}
