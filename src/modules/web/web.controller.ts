import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';

@Controller()
export class WebController {
  @Get('/')
  root(@Res() res: Response) {
    return res.redirect('/chat');
  }

  @Get('/chat')
  chat(@Res() res: Response) {
    return res.render('pages/chat', {
      title: 'Advisor Agent',
    });
  }

  @Get('/threads')
  threads(@Res() res: Response) {
    return res.render('pages/threads', {
      title: 'Advisor Agent',
    });
  }
}
