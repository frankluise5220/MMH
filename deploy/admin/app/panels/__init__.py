#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""面板包：导入即注册路由。

新增面板 = 新建 panels/xxx.py + 在下面加一行 import。
"""

from . import downloads      # noqa: F401
from . import issues         # noqa: F401
from . import mail           # noqa: F401
from . import mail_templates  # noqa: F401
from . import overview       # noqa: F401
from . import registrations  # noqa: F401
from . import relay          # noqa: F401
from . import settings       # noqa: F401
